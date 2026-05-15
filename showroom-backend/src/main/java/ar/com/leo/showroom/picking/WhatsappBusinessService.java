package ar.com.leo.showroom.picking;

import ar.com.leo.showroom.common.exception.UserMessages;
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
 *   <li>{@code showroom.whatsapp.mensaje-cuerpo} — texto que acompaña al PDF
 *       como caption. Soporta {@code {nombre}} como placeholder del cliente.
 *   <li>{@code showroom.whatsapp.default-country-code} — prefijo internacional
 *       a anteponer si el teléfono cargado en el pedido no lo trae. Default 54
 *       (Argentina); incluye el "9" automático para móviles.
 * </ul>
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

    private final PresupuestoPdfGenerator pdfGenerator;
    private final SesionShowroomRepository sesionRepository;
    private final SyncEventService eventService;
    private final ObjectMapper objectMapper;
    private final RestClient restClient;

    @Value("${showroom.whatsapp.enabled:false}")
    private boolean enabled;

    @Value("${showroom.whatsapp.phone-number-id:}")
    private String phoneNumberId;

    @Value("${showroom.whatsapp.access-token:}")
    private String accessToken;

    @Value("${showroom.whatsapp.api-version:v25.0}")
    private String apiVersion;

    @Value("${showroom.whatsapp.mensaje-cuerpo:Hola {nombre}, te dejamos un PDF con los productos que viste hoy en el showroom de KT GASTRO. ¡Gracias por tu visita!}")
    private String mensajeCuerpo;

    @Value("${showroom.whatsapp.default-country-code:54}")
    private String defaultCountryCode;

    public WhatsappBusinessService(
            PresupuestoPdfGenerator pdfGenerator,
            SesionShowroomRepository sesionRepository,
            SyncEventService eventService,
            ObjectMapper objectMapper) {
        this.pdfGenerator = pdfGenerator;
        this.sesionRepository = sesionRepository;
        this.eventService = eventService;
        this.objectMapper = objectMapper;
        // RestClient genérico — la base URL se compone por request porque el
        // path incluye el phone_number_id. El access_token va como Bearer header
        // en cada llamada (set en buildRestClient bajo demanda).
        this.restClient = RestClient.builder()
                .baseUrl("https://graph.facebook.com")
                .build();
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
        enviarPedidoSync(pedido); // fire-and-forget, ignora outcome
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
                t -> WhatsappBusinessEvent.windowClosedPedido(pedido.getId(), t));

        return enviarPdfInterno(
                telefonoRaw,
                () -> pdfGenerator.generarHistorial(sesion, pedido),
                () -> pdfGenerator.nombreArchivo(pedido),
                pedido.getNombreCompleto(),
                "pedido " + pedido.getId(),
                factories,
                /* emitirSkipsComoFailed */ false);
    }

    /**
     * Mandado desde el botón WhatsApp en /historial para sesiones ABANDONADAS.
     * El PDF incluye TODOS los items escaneados (no hay diff contra pedido).
     */
    @Async
    public void enviarPdfSesionAsync(SesionShowroom sesion, String telefonoRaw) {
        EventFactories factories = new EventFactories(
                t -> WhatsappBusinessEvent.sentSesion(sesion.getId(), t),
                (t, err) -> WhatsappBusinessEvent.failedSesion(sesion.getId(), t, err),
                t -> WhatsappBusinessEvent.windowClosedSesion(sesion.getId(), t));

        enviarPdfInterno(
                telefonoRaw,
                () -> pdfGenerator.generarHistorialSesion(sesion),
                () -> pdfGenerator.nombreArchivoSesion(sesion),
                sesion.getNombre(),
                "sesión " + sesion.getId(),
                factories,
                /* emitirSkipsComoFailed */ true);
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
            boolean emitirSkipsComoFailed) {
        Optional<String> motivo = motivoNoConfigurado();
        if (motivo.isPresent()) {
            log.debug("WhatsApp no disponible: {}. {} no se envía.", motivo.get(), logContext);
            if (emitirSkipsComoFailed) {
                eventService.publish(SSE_EVENT, factories.failed.apply(telefonoRaw, motivo.get()));
            }
            return false;
        }
        if (!StringUtils.hasText(telefonoRaw)) {
            log.warn("{} sin teléfono — no se manda WhatsApp.", logContext);
            if (emitirSkipsComoFailed) {
                eventService.publish(SSE_EVENT,
                        factories.failed.apply(null, "Falta el teléfono del cliente."));
            }
            return false;
        }
        String telefono = normalizarTelefono(telefonoRaw);
        if (telefono == null) {
            log.warn("{} con teléfono inválido '{}' — no se manda WhatsApp.", logContext, telefonoRaw);
            eventService.publish(SSE_EVENT,
                    factories.failed.apply(telefonoRaw, "Teléfono con formato inválido — revisar el dato cargado."));
            return false;
        }

        byte[] pdf;
        try {
            pdf = pdfSupplier.get();
        } catch (Exception ex) {
            log.warn("No se pudo generar el PDF para WhatsApp {}: {}", logContext, ex.getMessage(), ex);
            eventService.publish(SSE_EVENT,
                    factories.failed.apply(telefono,
                            UserMessages.traducir(ex, "No se pudo generar el PDF de follow-up.")));
            return false;
        }
        if (pdf == null) {
            log.info("{} sin items extra — no hay PDF que mandar.", logContext);
            if (emitirSkipsComoFailed) {
                eventService.publish(SSE_EVENT,
                        factories.failed.apply(telefono,
                                "La sesión no tiene items escaneados — no hay PDF que mandar."));
            }
            return false;
        }

        try {
            String filename = filenameSupplier.get();
            String mediaId = subirMedia(pdf, filename);
            String caption = renderCuerpo(nombreClienteParaCaption);
            enviarDocumento(telefono, mediaId, caption, filename);
            log.info("WhatsApp enviado a {} para {} ({} KB)", telefono, logContext, pdf.length / 1024);
            eventService.publish(SSE_EVENT, factories.sent.apply(telefono));
            return true;
        } catch (HttpClientErrorException e) {
            int metaCode = extraerErrorCodeMeta(e.getResponseBodyAsString());
            if (metaCode == META_ERROR_WINDOW_CLOSED) {
                log.info("WhatsApp {} — ventana 24hs cerrada para {}", logContext, telefono);
                eventService.publish(SSE_EVENT, factories.windowClosed.apply(telefono));
            } else if (metaCode == META_ERROR_PAIR_RATE_LIMIT) {
                log.warn("WhatsApp {} — pair rate limit (1 msg/6s) excedido para {}", logContext, telefono);
                eventService.publish(SSE_EVENT,
                        factories.failed.apply(telefono,
                                "Demasiados mensajes seguidos al mismo número. Esperá ~6s y reintentá."));
            } else if (metaCode == META_ERROR_PERMISSIONS) {
                log.error("WhatsApp {} — permisos insuficientes del token. " +
                        "Revisar en Meta Business Settings: el system user debe tener acceso a la WABA " +
                        "y los permisos business_management + whatsapp_business_management + " +
                        "whatsapp_business_messaging.", logContext);
                eventService.publish(SSE_EVENT,
                        factories.failed.apply(telefono,
                                "Permisos del token insuficientes — revisar config en Meta Business Settings."));
            } else {
                log.error("WhatsApp {} falló ({}): {}", logContext, e.getStatusCode(),
                        e.getResponseBodyAsString(), e);
                eventService.publish(SSE_EVENT,
                        factories.failed.apply(telefono,
                                resumirErrorMeta(e.getResponseBodyAsString(), e.getMessage())));
            }
            return false;
        } catch (Exception e) {
            log.error("WhatsApp {} falló: {}", logContext, e.getMessage(), e);
            eventService.publish(SSE_EVENT,
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
            java.util.function.Function<String, WhatsappBusinessEvent> windowClosed
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
     *  configura un mensaje muy largo. */
    private void enviarDocumento(String to, String mediaId, String caption, String filename) {
        String captionSafe = caption != null && caption.length() > 1024
                ? caption.substring(0, 1024)
                : caption;
        Map<String, Object> body = Map.of(
                "messaging_product", "whatsapp",
                "recipient_type", "individual",
                // Meta acepta el número con o sin '+', pero la doc oficial usa '+',
                // y mantenerlo así evita ambigüedad si en el futuro Meta endurece
                // la validación.
                "to", "+" + to,
                "type", "document",
                "document", Map.of(
                        "id", mediaId,
                        "caption", captionSafe,
                        "filename", filename
                )
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
     *  cliente. Recibe directamente el string para servir a los 2 callers
     *  (pedido.nombreCompleto y sesion.nombre) sin acoplar a un tipo concreto. */
    private String renderCuerpo(String nombreClienteRaw) {
        String nombre = nombreClienteRaw != null && !nombreClienteRaw.isBlank()
                ? nombreClienteRaw.trim() : "";
        return mensajeCuerpo.replace("{nombre}", nombre).trim();
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
