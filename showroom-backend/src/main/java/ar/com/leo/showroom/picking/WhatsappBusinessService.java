package ar.com.leo.showroom.picking;

import ar.com.leo.showroom.auth.repository.UsuarioRepository;
import ar.com.leo.showroom.common.exception.UserMessages;
import ar.com.leo.showroom.config.service.ConfiguracionService;
import ar.com.leo.showroom.events.SyncEventService;
import ar.com.leo.showroom.events.WhatsappBusinessEvent;
import ar.com.leo.showroom.pedido.entity.PedidoShowroom;
import ar.com.leo.showroom.sesion.entity.SesionShowroom;
import ar.com.leo.showroom.sesion.repository.SesionShowroomRepository;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.ByteArrayResource;
import org.springframework.http.MediaType;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Service;
import org.springframework.util.LinkedMultiValueMap;
import org.springframework.util.MultiValueMap;
import org.springframework.util.StringUtils;
import org.springframework.web.client.HttpClientErrorException;
import org.springframework.web.client.RestClient;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;

/**
 * Envía el PDF de productos vistos pero no comprados por WhatsApp usando la
 * Meta Cloud API (graph.facebook.com). Se invoca async tras cada pedido OK,
 * en paralelo al {@link PickingEmailService}, y también se puede disparar
 * manualmente desde el endpoint {@code POST /pedidos/{id}/whatsapp}.
 *
 * <p><b>Estrategia "free-form within 24h window":</b> Meta solo permite mandar
 * mensajes sin template aprobado dentro de las 24hs desde el último mensaje
 * del cliente. Como el cliente probablemente escribió antes de venir al
 * showroom para coordinar la visita, esa ventana suele estar abierta — el flujo
 * no necesita template approval. Si el cliente no escribió, Meta devuelve el
 * error 131047 y emitimos {@link WhatsappBusinessEvent.Estado#WINDOW_CLOSED}.
 *
 * <p><b>Configuración (env vars / application.properties):</b>
 * <ul>
 *   <li>{@code showroom.whatsapp.enabled} — habilita el envío. Default false.
 *   <li>{@code showroom.whatsapp.phone-number-id} — id del número en Meta
 *       (no el número en sí, sino su id interno de WABA).
 *   <li>{@code showroom.whatsapp.access-token} — <b>System User Access Token</b>
 *       (NO user token — esos expiran cada pocas horas). Se genera en
 *       Meta Business Settings → Usuarios del sistema → Generar token, con
 *       los 3 permisos: {@code business_management},
 *       {@code whatsapp_business_management}, {@code whatsapp_business_messaging}.
 *       Además el system user tiene que tener acceso a activos comerciales
 *       sobre la WABA (full o granular sobre el número).
 *   <li>{@code showroom.whatsapp.api-version} — versión de Graph API. Default v25.0.
 *   <li>{@code showroom.whatsapp.default-country-code} — prefijo internacional
 *       a anteponer si el teléfono cargado en el pedido no lo trae. Default 54
 *       (Argentina); incluye el "9" automático para móviles.
 * </ul>
 *
 * <p><b>Mensaje (caption del PDF):</b> NO se configura por .properties — se
 * carga desde la pantalla {@code /configuracion} (persistido en la tabla
 * {@code configuracion}, clave {@code whatsapp.mensaje-cuerpo}). Soporta el
 * placeholder {@code {nombre}} y el formato nativo de WhatsApp
 * ({@code *negrita*}, {@code _itálica_}, {@code ~tachado~}, {@code `mono`}).
 * Si el operador no configuró ninguno, el PDF se envía sin caption.
 */
@Slf4j
@Service
public class WhatsappBusinessService {

    /** Nombre del evento SSE para los toasts del frontend. */
    private static final String SSE_EVENT = "whatsapp-business";

    /** Código que devuelve Meta cuando el cliente no escribió en las últimas
     *  24hs y no estás usando un template aprobado. Documentado en
     *  https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes */
    private static final int META_ERROR_WINDOW_CLOSED = 131047;

    /** Pair rate limit: 1 mensaje cada 6s al mismo usuario (10/min, 600/hora).
     *  Se gatilla si el operador clickea "reenviar" muchas veces seguidas en
     *  el mismo pedido. Lo tratamos como FAILED con mensaje específico para
     *  que sepa que tiene que esperar antes de reintentar. */
    private static final int META_ERROR_PAIR_RATE_LIMIT = 131056;

    /** Permisos insuficientes — el system user del token no tiene acceso al
     *  recurso (WABA o phone_number_id). Error de configuración, NO transient:
     *  hay que revisar permisos del token en Business Settings. */
    private static final int META_ERROR_PERMISSIONS = 200;

    /** PDF de "ítems de interés" (productos vistos pero no comprados) en formato
     *  agregado liviano — se usa tanto para sesiones abandonadas como para el
     *  follow-up tras pedido por WhatsApp. */
    private final ar.com.leo.showroom.presupuesto.service.PresupuestoComercialPdfGenerator itemsDeInteresPdfGenerator;
    private final SesionShowroomRepository sesionRepository;
    private final SyncEventService eventService;
    private final ObjectMapper objectMapper;
    private final ConfiguracionService configuracionService;
    private final RestClient restClient;
    /** Para resolver {@code pedido.usuarioId} / {@code sesion.usuarioId} a
     *  username y publicar el toast SSE solo al operador propietario. */
    private final UsuarioRepository usuarioRepository;

    @Value("${showroom.whatsapp.enabled:false}")
    private boolean enabled;

    @Value("${showroom.whatsapp.phone-number-id:}")
    private String phoneNumberId;

    @Value("${showroom.whatsapp.access-token:}")
    private String accessToken;

    @Value("${showroom.whatsapp.api-version:v25.0}")
    private String apiVersion;

    @Value("${showroom.whatsapp.default-country-code:54}")
    private String defaultCountryCode;

    public WhatsappBusinessService(
            ar.com.leo.showroom.presupuesto.service.PresupuestoComercialPdfGenerator itemsDeInteresPdfGenerator,
            SesionShowroomRepository sesionRepository,
            SyncEventService eventService,
            ObjectMapper objectMapper,
            ConfiguracionService configuracionService,
            RestClient.Builder restClientBuilder,
            UsuarioRepository usuarioRepository) {
        this.itemsDeInteresPdfGenerator = itemsDeInteresPdfGenerator;
        this.sesionRepository = sesionRepository;
        this.eventService = eventService;
        this.objectMapper = objectMapper;
        this.configuracionService = configuracionService;
        this.usuarioRepository = usuarioRepository;
        // Partimos del builder autoconfigurado por Spring Boot — hereda el
        // ClientHttpRequestFactory auto-detectado y los timeouts globales de
        // spring.http.clients.*. El access_token va como Bearer header por request.
        this.restClient = restClientBuilder
                .baseUrl("https://graph.facebook.com")
                .build();
    }

    /** Resuelve {@code usuarioId} a username. Null si no se puede resolver
     *  (legacy pedido/sesión sin usuario) — en ese caso el SSE va global. */
    private String usernameDe(Long usuarioId) {
        if (usuarioId == null) return null;
        return usuarioRepository.findById(usuarioId).map(u -> u.getUsername()).orElse(null);
    }

    private void publicarEvento(String operador, Object payload) {
        if (operador != null) {
            eventService.publishTo(operador, SSE_EVENT, payload);
        } else {
            eventService.publish(SSE_EVENT, payload);
        }
    }

    /**
     * Motivo por el cual el envío no es posible a nivel sistema (config faltante),
     * o vacío si está todo OK. Lo usa el controller para responder al disparo
     * manual con un 503 explicativo.
     */
    public Optional<String> motivoNoConfigurado() {
        if (!enabled) {
            return Optional.of("WhatsApp deshabilitado en config (showroom.whatsapp.enabled=false)");
        }
        if (!StringUtils.hasText(phoneNumberId)) {
            return Optional.of("Falta showroom.whatsapp.phone-number-id");
        }
        if (!StringUtils.hasText(accessToken)) {
            return Optional.of("Falta showroom.whatsapp.access-token");
        }
        return Optional.empty();
    }

    /**
     * Mandado desde el botón WhatsApp en /pedidos (manual). Fire-and-forget —
     * el toast SSE confirma el resultado. Para el flujo automático tras pedido,
     * el orquestador {@code PdfFollowupOrchestrator} llama a {@link #enviarPedidoSync}
     * que devuelve si fue enviado o no para decidir el fallback al email.
     */
    @Async
    public void enviarPdfAsync(PedidoShowroom pedido) {
        // Path automático post-pedido — el toast va al creador del pedido
        // (operador autenticado = creador en este flujo).
        enviarPedidoSync(pedido, null);
    }

    /**
     * Disparo manual desde {@code POST /pedidos/{id}/whatsapp}. {@code operadorActual}
     * es el username del que apretó el botón — puede no ser el creador del
     * pedido. El toast SSE va a SU pantalla para que reciba la confirmación
     * inmediata sin tener que mirar la pantalla del creador.
     */
    @Async
    public void enviarPdfAsync(PedidoShowroom pedido, String operadorActual) {
        enviarPedidoSync(pedido, operadorActual);
    }

    /**
     * Versión sincrónica de {@link #enviarPdfAsync} que devuelve si el envío
     * fue exitoso. La usa {@code PdfFollowupOrchestrator} dentro de su propio
     * @Async para encadenar email como fallback si WhatsApp no llegó.
     *
     * @return {@code true} si el PDF se entregó por WhatsApp; {@code false}
     *         para cualquier otro outcome (skip, falla, ventana cerrada, etc.).
     *         En todos los casos se emite el SSE correspondiente.
     */
    public boolean enviarPedidoSync(PedidoShowroom pedido) {
        return enviarPedidoSync(pedido, null);
    }

    /**
     * Versión con override: {@code operadorActual} dirige el toast SSE al
     * operador que disparó la acción (no necesariamente el creador del pedido).
     * Si {@code operadorActual} es null, cae al creador como fallback —
     * comportamiento del flujo automático post-pedido.
     */
    public boolean enviarPedidoSync(PedidoShowroom pedido, String operadorActual) {
        if (!enabled || !StringUtils.hasText(phoneNumberId) || !StringUtils.hasText(accessToken)) {
            log.debug("WhatsApp no disponible — pedido {} no se envía.", pedido.getId());
            return false;
        }
        String telefonoRaw = pedido.getTelefono();
        if (!StringUtils.hasText(telefonoRaw)) {
            log.warn("Pedido {} sin teléfono del cliente — no se manda WhatsApp.", pedido.getId());
            return false;
        }

        Optional<SesionShowroom> sesionOpt = sesionRepository.findByPedidoIdWithItems(pedido.getId());
        if (sesionOpt.isEmpty()) {
            log.info("Pedido {} sin sesión asociada — no se manda WhatsApp.", pedido.getId());
            return false;
        }
        SesionShowroom sesion = sesionOpt.get();

        EventFactories factories = new EventFactories(
                t -> WhatsappBusinessEvent.sentPedido(pedido.getId(), t),
                (t, err) -> WhatsappBusinessEvent.failedPedido(pedido.getId(), t, err),
                t -> WhatsappBusinessEvent.windowClosedPedido(pedido.getId(), t),
                (t, motivo) -> WhatsappBusinessEvent.skippedPedido(pedido.getId(), t, motivo));

        // Operador efectivo para el toast: override del que apretó el botón
        // (si vino) sino el creador del pedido (caso auto post-pedido).
        String operador = operadorActual != null ? operadorActual
                : usernameDe(pedido.getUsuarioId());
        return enviarPdfInterno(
                telefonoRaw,
                () -> itemsDeInteresPdfGenerator.generarItemsDeInteres(sesion, pedido),
                () -> itemsDeInteresPdfGenerator.nombreArchivoItemsDeInteres(sesion),
                pedido.getNombreCompleto(),
                "pedido " + pedido.getId(),
                factories,
                /* emitirSkipsComoFailed */ false,
                operador);
    }

    /**
     * Mandado desde el botón WhatsApp en /historial para sesiones ABANDONADAS.
     * El PDF incluye TODOS los items escaneados (no hay diff contra pedido).
     */
    @Async
    public void enviarPdfSesionAsync(SesionShowroom sesion, String telefonoRaw) {
        enviarPdfSesionAsync(sesion, telefonoRaw, null);
    }

    /**
     * Versión con override — el toast SSE va al operador que apretó el botón
     * (pasa {@code auth.getName()} desde el controller), no al dueño de la
     * sesión. Si {@code operadorActual} es null, cae al dueño como fallback.
     */
    @Async
    public void enviarPdfSesionAsync(SesionShowroom sesion, String telefonoRaw, String operadorActual) {
        EventFactories factories = new EventFactories(
                t -> WhatsappBusinessEvent.sentSesion(sesion.getId(), t),
                (t, err) -> WhatsappBusinessEvent.failedSesion(sesion.getId(), t, err),
                t -> WhatsappBusinessEvent.windowClosedSesion(sesion.getId(), t),
                (t, motivo) -> WhatsappBusinessEvent.skippedSesion(sesion.getId(), t, motivo));

        String operador = operadorActual != null ? operadorActual
                : usernameDe(sesion.getUsuarioId());
        enviarPdfInterno(
                telefonoRaw,
                () -> itemsDeInteresPdfGenerator.generarItemsDeInteres(sesion),
                () -> itemsDeInteresPdfGenerator.nombreArchivoItemsDeInteres(sesion),
                sesion.getNombre(),
                "sesión " + sesion.getId(),
                factories,
                /* emitirSkipsComoFailed */ true,
                operador);
        // Sesión-path no necesita el outcome — lo descartamos. El fallback a
        // email solo aplica al flujo automático tras pedido (orquestador).
    }

    /**
     * Orquestador común — gating + normalización del teléfono + generación del
     * PDF + upload + send + manejo de errores Meta-specific (ventana 24hs,
     * rate limit, permisos).
     *
     * @param emitirSkipsComoFailed para el path "sesión sin pedido" emitimos
     *        FAILED en skips (config, sin items) porque el operador esperaba
     *        un toast. Para el path "auto post-pedido" los skips son silenciosos
     *        (no hay UI esperando).
     * @return {@code true} si el PDF se entregó por WhatsApp; {@code false} en
     *         cualquier otro outcome (skip, falla de red, ventana cerrada, rate
     *         limit, permisos). El orquestador usa este valor para decidir si
     *         encadena fallback a email.
     */
    private boolean enviarPdfInterno(
            String telefonoRaw,
            java.util.function.Supplier<byte[]> pdfSupplier,
            java.util.function.Supplier<String> filenameSupplier,
            String nombreClienteParaCaption,
            String logContext,
            EventFactories factories,
            boolean emitirSkipsComoFailed,
            String operador) {
        Optional<String> motivo = motivoNoConfigurado();
        if (motivo.isPresent()) {
            log.debug("WhatsApp no disponible: {}. {} no se envía.", motivo.get(), logContext);
            if (emitirSkipsComoFailed) {
                publicarEvento(operador, factories.failed.apply(telefonoRaw, motivo.get()));
            }
            return false;
        }
        if (!StringUtils.hasText(telefonoRaw)) {
            log.warn("{} sin teléfono — no se manda WhatsApp.", logContext);
            if (emitirSkipsComoFailed) {
                publicarEvento(operador,
                        factories.failed.apply(null, "Falta el teléfono del cliente."));
            }
            return false;
        }
        String telefono = normalizarTelefono(telefonoRaw);
        if (telefono == null) {
            log.warn("{} con teléfono inválido '{}' — no se manda WhatsApp.", logContext, telefonoRaw);
            publicarEvento(operador,
                    factories.failed.apply(telefonoRaw, "Teléfono con formato inválido — revisar el dato cargado."));
            return false;
        }

        byte[] pdf;
        try {
            pdf = pdfSupplier.get();
        } catch (Exception ex) {
            log.warn("No se pudo generar el PDF para WhatsApp {}: {}", logContext, ex.getMessage(), ex);
            publicarEvento(operador,
                    factories.failed.apply(telefono,
                            UserMessages.traducir(ex, "No se pudo generar el PDF de follow-up.")));
            return false;
        }
        if (pdf == null) {
            String motivoBase = emitirSkipsComoFailed
                    ? "La sesión no tiene items escaneados — no hay PDF que mandar."
                    : "El cliente compró todo lo que vio — no hay PDF de productos extra para mandar.";
            log.info("{} — {}", logContext, motivoBase);
            if (emitirSkipsComoFailed) {
                // Path sesión-abandonada: no hay items escaneados → es un error
                // de input del operador (debería tener algo en la sesión).
                publicarEvento(operador,
                        factories.failed.apply(telefono, motivoBase));
            } else {
                // Path pedido (manual desde /pedidos o auto post-pedido): no es
                // un error, el cliente compró todo lo que vio. Emitimos SKIPPED
                // para que el operador reciba un toast informativo.
                publicarEvento(operador,
                        factories.skipped.apply(telefono, motivoBase));
            }
            return false;
        }

        try {
            String filename = filenameSupplier.get();
            String mediaId = subirMedia(pdf, filename);
            String caption = renderCuerpo(nombreClienteParaCaption);
            enviarDocumento(telefono, mediaId, caption, filename);
            log.info("WhatsApp enviado a {} para {} ({} KB)", telefono, logContext, pdf.length / 1024);
            publicarEvento(operador, factories.sent.apply(telefono));
            return true;
        } catch (HttpClientErrorException e) {
            int metaCode = extraerErrorCodeMeta(e.getResponseBodyAsString());
            if (metaCode == META_ERROR_WINDOW_CLOSED) {
                log.info("WhatsApp {} — ventana 24hs cerrada para {}", logContext, telefono);
                publicarEvento(operador, factories.windowClosed.apply(telefono));
            } else if (metaCode == META_ERROR_PAIR_RATE_LIMIT) {
                log.warn("WhatsApp {} — pair rate limit (1 msg/6s) excedido para {}", logContext, telefono);
                publicarEvento(operador,
                        factories.failed.apply(telefono,
                                "Demasiados mensajes seguidos al mismo número. Esperá ~6s y reintentá."));
            } else if (metaCode == META_ERROR_PERMISSIONS) {
                log.error("WhatsApp {} — permisos insuficientes del token. " +
                        "Revisar en Meta Business Settings: el system user debe tener acceso a la WABA " +
                        "y los permisos business_management + whatsapp_business_management + " +
                        "whatsapp_business_messaging.", logContext);
                publicarEvento(operador,
                        factories.failed.apply(telefono,
                                "Permisos del token insuficientes — revisar config en Meta Business Settings."));
            } else {
                log.error("WhatsApp {} falló ({}): {}", logContext, e.getStatusCode(),
                        e.getResponseBodyAsString(), e);
                publicarEvento(operador,
                        factories.failed.apply(telefono,
                                resumirErrorMeta(e.getResponseBodyAsString(), e.getMessage())));
            }
            return false;
        } catch (Exception e) {
            log.error("WhatsApp {} falló: {}", logContext, e.getMessage(), e);
            publicarEvento(operador,
                    factories.failed.apply(telefono,
                            UserMessages.traducir(e, "No se pudo enviar el WhatsApp. Revisar logs del backend.")));
            return false;
        }
    }

    /** Bundle de factories que producen eventos SSE para cada outcome. Cada
     *  caller (pedido vs sesión) arma su propio bundle apuntando a las factories
     *  estáticas {@code sentPedido/sentSesion}, etc. del record. */
    private record EventFactories(
            java.util.function.Function<String, WhatsappBusinessEvent> sent,
            java.util.function.BiFunction<String, String, WhatsappBusinessEvent> failed,
            java.util.function.Function<String, WhatsappBusinessEvent> windowClosed,
            java.util.function.BiFunction<String, String, WhatsappBusinessEvent> skipped
    ) {}

    /** Sube el PDF a Meta y devuelve el media_id que se usa luego para mandar
     *  el mensaje. Multipart con file + messaging_product + type. */
    private String subirMedia(byte[] pdf, String filename) {
        MultiValueMap<String, Object> body = new LinkedMultiValueMap<>();
        body.add("messaging_product", "whatsapp");
        body.add("type", "application/pdf");
        body.add("file", new ByteArrayResource(pdf) {
            @Override public String getFilename() { return filename; }
        });

        String response = restClient.post()
                .uri("/{version}/{phoneId}/media", apiVersion, phoneNumberId)
                .header("Authorization", "Bearer " + accessToken)
                .contentType(MediaType.MULTIPART_FORM_DATA)
                .body(body)
                .retrieve()
                .body(String.class);
        try {
            JsonNode node = objectMapper.readTree(response);
            String id = node.path("id").asText(null);
            if (!StringUtils.hasText(id)) {
                throw new IllegalStateException("Meta no devolvió media id. Respuesta: " + response);
            }
            return id;
        } catch (Exception e) {
            throw new IllegalStateException("Error parseando respuesta de Meta /media: " + e.getMessage(), e);
        }
    }

    /** Manda el mensaje tipo document con el media_id ya subido + caption.
     *  Body según doc oficial Meta: messaging_product + recipient_type +
     *  to + type + document (id, caption, filename). Caption hard-cap a 1024
     *  caracteres (límite documentado) — truncamos por las dudas si el operador
     *  configura un mensaje muy largo. Si el caption está vacío, lo omitimos
     *  del payload (Meta acepta el documento sin caption). */
    private void enviarDocumento(String to, String mediaId, String caption, String filename) {
        // Map.of no admite valores null; armamos el sub-map condicionalmente
        // para no incluir "caption" cuando no hay texto.
        Map<String, Object> documento = new LinkedHashMap<>();
        documento.put("id", mediaId);
        documento.put("filename", filename);
        if (caption != null && !caption.isEmpty()) {
            String captionSafe = caption.length() > 1024 ? caption.substring(0, 1024) : caption;
            documento.put("caption", captionSafe);
        }
        Map<String, Object> body = Map.of(
                "messaging_product", "whatsapp",
                "recipient_type", "individual",
                // Meta acepta el número con o sin '+', pero la doc oficial usa '+',
                // y mantenerlo así evita ambigüedad si en el futuro Meta endurece
                // la validación.
                "to", "+" + to,
                "type", "document",
                "document", documento
        );
        restClient.post()
                .uri("/{version}/{phoneId}/messages", apiVersion, phoneNumberId)
                .header("Authorization", "Bearer " + accessToken)
                .contentType(MediaType.APPLICATION_JSON)
                .body(body)
                .retrieve()
                .body(String.class);
    }

    private int extraerErrorCodeMeta(String responseBody) {
        if (responseBody == null) return -1;
        try {
            JsonNode node = objectMapper.readTree(responseBody);
            return node.path("error").path("code").asInt(-1);
        } catch (Exception e) {
            return -1;
        }
    }

    private String resumirErrorMeta(String responseBody, String fallback) {
        if (responseBody == null) return fallback;
        try {
            JsonNode err = objectMapper.readTree(responseBody).path("error");
            String msg = err.path("message").asText(null);
            return StringUtils.hasText(msg) ? msg : fallback;
        } catch (Exception e) {
            return fallback;
        }
    }

    /** Renderiza el caption del PDF reemplazando {nombre} por el nombre del
     *  cliente. El texto base se lee de {@link ConfiguracionService} en cada
     *  envío. Si el operador todavía no configuró un mensaje desde
     *  /configuracion, devuelve cadena vacía y el PDF se manda sin caption.
     *  Recibe el string directo para servir a los 2 callers
     *  (pedido.nombreCompleto y sesion.nombre) sin acoplar a un tipo concreto. */
    private String renderCuerpo(String nombreClienteRaw) {
        String cuerpo = configuracionService.getWhatsappMensajeCuerpo();
        if (cuerpo == null || cuerpo.isEmpty()) {
            return "";
        }
        String nombre = nombreClienteRaw != null && !nombreClienteRaw.isBlank()
                ? nombreClienteRaw.trim() : "";
        return cuerpo.replace("{nombre}", nombre).trim();
    }

    /**
     * Normaliza el teléfono al formato que pide Meta: solo dígitos, con código
     * de país. Para Argentina, además inserta el "9" entre el código de país y
     * el área si falta — WhatsApp requiere ese "9" para móviles.
     *
     * <p>Devuelve null si tras la limpieza no queda nada usable (muy pocos
     * dígitos, etc.). El caller emite FAILED en ese caso.
     */
    String normalizarTelefono(String raw) {
        if (raw == null) return null;
        String digits = raw.replaceAll("\\D", "");
        if (digits.length() < 8) return null;

        String cc = defaultCountryCode.replaceAll("\\D", "");
        // Caso AR: si arranca con 54 pero NO con 549, e ingresa un móvil
        // (típicamente 12 dígitos = 54 + área + abonado de 8), insertamos el 9.
        if ("54".equals(cc)) {
            if (digits.startsWith("549")) return digits;
            if (digits.startsWith("54") && digits.length() >= 11) {
                return "549" + digits.substring(2);
            }
            // 10-11 dígitos sin código de país → asumir AR móvil.
            if (digits.length() >= 10 && digits.length() <= 11) {
                return "549" + digits;
            }
            return digits;
        }
        // Otros países: si no arranca con el cc, anteponerlo.
        if (!digits.startsWith(cc)) {
            return cc + digits;
        }
        return digits;
    }
}
