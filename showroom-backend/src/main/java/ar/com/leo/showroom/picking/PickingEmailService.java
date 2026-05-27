package ar.com.leo.showroom.picking;

import ar.com.leo.showroom.auth.repository.UsuarioRepository;
import ar.com.leo.showroom.common.exception.UserMessages;
import ar.com.leo.showroom.events.PickingEmailEvent;
import ar.com.leo.showroom.events.SyncEventService;
import ar.com.leo.showroom.pedido.entity.PedidoShowroom;
import ar.com.leo.showroom.sesion.entity.SesionShowroom;
import ar.com.leo.showroom.sesion.repository.SesionShowroomRepository;
import jakarta.mail.internet.MimeMessage;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.ByteArrayResource;
import org.springframework.mail.javamail.JavaMailSender;
import org.springframework.mail.javamail.MimeMessageHelper;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;

import java.net.SocketTimeoutException;
import java.util.Optional;
import java.util.function.BiFunction;
import java.util.function.Function;

/**
 * Envía el PDF de "productos vistos pero no comprados" por email. Dos disparos:
 *
 * <ul>
 *   <li>{@link #enviarAsync(PedidoShowroom)} — auto tras un pedido OK (en
 *       paralelo a WhatsApp y pickit) o manual desde el botón ✉️ en /pedidos.
 *       El destinatario sale de {@code pedido.email}.</li>
 *   <li>{@link #enviarPdfSesionAsync(SesionShowroom, String)} — manual desde
 *       el botón ✉️ en /historial para sesiones ABANDONADAS (sin pedido). El
 *       operador tipea el email en el dialog.</li>
 * </ul>
 *
 * <p>Ambos paths comparten la misma plantilla MIME y manejo de errores —
 * la lógica de envío vive en {@link #enviarPdfInterno}. Cada caller arma el
 * payload (destinatario, nombre, PDF, filename) y provee las factories de
 * eventos SSE para reportar SENT/FAILED.
 *
 * <p>Si {@code showroom.picking.email-enabled=false} o falta SMTP config,
 * loguea un warn y no manda nada (no rompe el flujo del pedido). El controller
 * usa {@link #motivoNoConfigurado()} para responder 503 al disparo manual.
 */
@Slf4j
@Service
public class PickingEmailService {

    private static final String SSE_EVENT = "picking-email";
    private static final String SUBJECT = "KT GASTRO — Productos que viste en el showroom";

    /** Genera el PDF de "ítems de interés" (productos vistos pero no comprados)
     *  en el formato agregado liviano — se usa tanto para sesiones abandonadas
     *  como para el follow-up tras pedido. */
    private final ar.com.leo.showroom.presupuesto.service.PresupuestoComercialPdfGenerator itemsDeInteresPdfGenerator;
    private final JavaMailSender mailSender;
    private final SyncEventService eventService;
    private final SesionShowroomRepository sesionRepository;
    /** Para resolver {@code pedido.usuarioId} / {@code sesion.usuarioId} a
     *  username y publicar el SSE en el canal personal del operador que
     *  disparó el envío — así el toast del email aparece solo en SU pantalla,
     *  no en la de todos los operadores logueados. */
    private final UsuarioRepository usuarioRepository;

    @Value("${showroom.picking.email-enabled:false}")
    private boolean enabled;

    @Value("${showroom.picking.email-from:}")
    private String emailFrom;

    @Value("${spring.mail.username:}")
    private String mailUsername;

    /**
     * Spring Boot autoconfigura JavaMailSender solo si hay config SMTP. Si no,
     * el bean podría no existir — usamos ObjectProvider para tolerar el caso.
     */
    public PickingEmailService(
            ar.com.leo.showroom.presupuesto.service.PresupuestoComercialPdfGenerator itemsDeInteresPdfGenerator,
            org.springframework.beans.factory.ObjectProvider<JavaMailSender> mailSender,
            SyncEventService eventService,
            SesionShowroomRepository sesionRepository,
            UsuarioRepository usuarioRepository) {
        this.itemsDeInteresPdfGenerator = itemsDeInteresPdfGenerator;
        this.mailSender = mailSender.getIfAvailable();
        this.eventService = eventService;
        this.sesionRepository = sesionRepository;
        this.usuarioRepository = usuarioRepository;
    }

    /** Resuelve el username del operador que disparó la operación a partir
     *  del {@code usuarioId} guardado en pedido/sesión. Null si no se puede
     *  resolver (legacy sin usuario) — en ese caso el SSE se publica global
     *  como fallback para no perder el toast. */
    private String usernameDe(Long usuarioId) {
        if (usuarioId == null) return null;
        return usuarioRepository.findById(usuarioId).map(u -> u.getUsername()).orElse(null);
    }

    /** Publica {@code event} al canal del operador {@code username}; si es null
     *  (legacy data o resolución fallida), broadcast global como fallback. */
    private void publicarEvento(String username, Object payload) {
        if (username != null) {
            eventService.publishTo(username, SSE_EVENT, payload);
        } else {
            eventService.publish(SSE_EVENT, payload);
        }
    }

    /**
     * Devuelve el motivo por el cual el envío no es posible a nivel sistema
     * (config faltante), o vacío si está todo OK. Lo usa el controller para
     * responder 503 al disparo manual con un mensaje claro.
     *
     * <p>La validación del destinatario por cada envío se hace dentro de los
     * métodos {@code enviar...Async} y no es chequeable acá.
     */
    public Optional<String> motivoNoConfigurado() {
        if (!enabled) {
            return Optional.of("Envío de email deshabilitado en config (showroom.picking.email-enabled=false)");
        }
        if (mailSender == null) {
            return Optional.of("JavaMailSender no configurado (revisar spring.mail.* en application.properties)");
        }
        return Optional.empty();
    }

    /**
     * Mandado desde el botón ✉️ en /pedidos (manual). Fire-and-forget — el toast
     * SSE confirma el resultado. Para el flujo automático tras pedido el
     * orquestador {@code PdfFollowupOrchestrator} llama a {@link #enviarPedidoSync}
     * que devuelve si fue enviado para decidir el fallback.
     */
    @Async
    public void enviarAsync(PedidoShowroom pedido) {
        // Path automático tras pedido OK — el operador autenticado coincide
        // con el creador, así que dejamos que enviarPedidoSync resuelva el
        // username del propio pedido.
        enviarPedidoSync(pedido, null);
    }

    /**
     * Disparo manual desde {@code POST /pedidos/{id}/email}. {@code operadorActual}
     * es el username del que apretó el botón — puede no ser el creador del
     * pedido (otro operador re-enviando un pedido ajeno). El toast SSE va a
     * la pantalla del operador que disparó, no del creador, para que reciba
     * la confirmación inmediata sin tener que mirar la pantalla de otro.
     */
    @Async
    public void enviarAsync(PedidoShowroom pedido, String operadorActual) {
        enviarPedidoSync(pedido, operadorActual);
    }

    /**
     * Versión sincrónica de {@link #enviarAsync} que devuelve si el envío fue
     * exitoso. La usa {@code PdfFollowupOrchestrator} dentro de su propio @Async
     * para encadenar/saltar fallback. Emite los mismos SSE que el path async.
     *
     * @return {@code true} si el email se entregó OK; {@code false} para
     *         cualquier otro outcome (skip, falla SMTP, sin destinatario, etc.).
     */
    public boolean enviarPedidoSync(PedidoShowroom pedido) {
        return enviarPedidoSync(pedido, null);
    }

    /**
     * Versión con override: {@code operadorActual} dirige el toast SSE al
     * operador que disparó la acción (no necesariamente el creador del pedido).
     * Lo usan los endpoints manuales del controller pasando {@code auth.getName()}.
     * Si {@code operadorActual} es null, se usa el creador del pedido como
     * fallback — comportamiento del flujo automático post-pedido OK.
     */
    public boolean enviarPedidoSync(PedidoShowroom pedido, String operadorActual) {
        // El operador efectivo del toast SSE: override del que apretó el botón
        // (si vino) sino el creador del pedido (caso auto post-pedido).
        String operador = operadorActual != null ? operadorActual
                : usernameDe(pedido.getUsuarioId());

        if (!enabled || mailSender == null) {
            log.debug("Email no disponible — pedido {} no se envía.", pedido.getId());
            return false;
        }
        String emailCliente = pedido.getEmail();
        if (!StringUtils.hasText(emailCliente)) {
            log.warn("Pedido {} sin email del cliente — no se manda el follow-up.", pedido.getId());
            return false;
        }

        Optional<SesionShowroom> sesionOpt = sesionRepository.findByPedidoIdWithItems(pedido.getId());
        if (sesionOpt.isEmpty()) {
            log.info("Pedido {} sin sesión asociada — no se manda email de follow-up.", pedido.getId());
            return false;
        }
        SesionShowroom sesion = sesionOpt.get();

        String cuit = cuitDe(pedido);
        Function<String, PickingEmailEvent> sentFactory =
                emailDest -> PickingEmailEvent.sentPedido(pedido.getId(), cuit, emailDest);
        BiFunction<String, String, PickingEmailEvent> failedFactory =
                (emailDest, err) -> PickingEmailEvent.failedPedido(pedido.getId(), cuit, emailDest, err);
        BiFunction<String, String, PickingEmailEvent> ambiguoFactory =
                (emailDest, detalle) -> PickingEmailEvent.ambiguoPedido(pedido.getId(), cuit, emailDest, detalle);

        byte[] pdf = generarPdfSeguro(
                () -> itemsDeInteresPdfGenerator.generarItemsDeInteres(sesion, pedido),
                "pedido " + pedido.getId(),
                emailCliente,
                failedFactory,
                operador);
        if (pdf == null) {
            // Caso "no items extra" — el cliente compró todo lo que vio. No es
            // un error técnico, pero igual notificamos al frontend con SKIPPED
            // para que el operador (que tocó el botón manual) reciba un toast
            // claro en vez de quedar esperando.
            String motivo = "El cliente compró todo lo que vio — no hay PDF de productos extra para mandar.";
            log.info("Pedido {} — {}", pedido.getId(), motivo);
            publicarEvento(operador, PickingEmailEvent.skippedPedido(
                    pedido.getId(), cuit, emailCliente, motivo));
            return false;
        }

        return enviarPdfInterno(
                emailCliente,
                pedido.getNombreCompleto(),
                pdf,
                itemsDeInteresPdfGenerator.nombreArchivoItemsDeInteres(sesion),
                "pedido " + pedido.getId(),
                sentFactory,
                failedFactory,
                ambiguoFactory,
                operador);
    }

    /**
     * Mandado desde el botón ✉️ en /historial para sesiones ABANDONADAS. El
     * PDF incluye TODOS los items escaneados (no hay diff contra pedido).
     */
    @Async
    public void enviarPdfSesionAsync(SesionShowroom sesion, String emailDestinatario) {
        // Sin override: el toast va al dueño de la sesión.
        enviarPdfSesionAsync(sesion, emailDestinatario, null);
    }

    /**
     * Versión con override — el toast SSE va al operador que apretó el botón
     * (pasa {@code auth.getName()} desde el controller), no al dueño de la
     * sesión. Si {@code operadorActual} es null, cae al dueño como fallback.
     */
    @Async
    public void enviarPdfSesionAsync(SesionShowroom sesion, String emailDestinatario, String operadorActual) {
        String operador = operadorActual != null ? operadorActual
                : usernameDe(sesion.getUsuarioId());

        Function<String, PickingEmailEvent> sentFactory =
                emailDest -> PickingEmailEvent.sentSesion(sesion.getId(), emailDest);
        BiFunction<String, String, PickingEmailEvent> failedFactory =
                (emailDest, err) -> PickingEmailEvent.failedSesion(sesion.getId(), emailDest, err);
        BiFunction<String, String, PickingEmailEvent> ambiguoFactory =
                (emailDest, detalle) -> PickingEmailEvent.ambiguoSesion(sesion.getId(), emailDest, detalle);

        Optional<String> motivo = motivoNoConfigurado();
        if (motivo.isPresent()) {
            log.debug("Email no disponible: {}. Sesión {} no se envía.", motivo.get(), sesion.getId());
            publicarEvento(operador, failedFactory.apply(emailDestinatario, motivo.get()));
            return;
        }
        if (!StringUtils.hasText(emailDestinatario)) {
            log.warn("Sesión {} sin email destinatario — no se manda email.", sesion.getId());
            publicarEvento(operador, failedFactory.apply(null, "Falta el email del cliente."));
            return;
        }

        byte[] pdf = generarPdfSeguro(
                () -> itemsDeInteresPdfGenerator.generarItemsDeInteres(sesion),
                "sesión " + sesion.getId(),
                emailDestinatario,
                failedFactory,
                operador);
        if (pdf == null) {
            log.info("Sesión {} sin items escaneados — no hay PDF que mandar.", sesion.getId());
            publicarEvento(operador, failedFactory.apply(emailDestinatario,
                    "La sesión no tiene items escaneados — no hay PDF que mandar."));
            return;
        }

        enviarPdfInterno(
                emailDestinatario,
                sesion.getNombre(),
                pdf,
                itemsDeInteresPdfGenerator.nombreArchivoItemsDeInteres(sesion),
                "sesión " + sesion.getId(),
                sentFactory,
                failedFactory,
                ambiguoFactory,
                operador);
    }

    /**
     * Orquestador común: arma el MimeMessage con el PDF adjunto, dispara el
     * envío SMTP y publica el evento SSE correspondiente. Los callers pasan
     * las factories de eventos para que cada path emita {@code *Pedido} o
     * {@code *Sesion} según el contexto.
     *
     * <p>Excepciones del SMTP se loguean + publican como FAILED pero no se
     * propagan: el pedido ya está en DUX, no podemos revertirlo si el email
     * falla.
     *
     * @param logContext referencia humana para los logs (ej. "pedido 42",
     *                   "sesión 17").
     * @return {@code true} si el email se mandó OK (mailSender.send no tiró);
     *         {@code false} si SMTP falló. El caller usa el booleano cuando
     *         decide encadenar con otro canal (ver {@code PdfFollowupOrchestrator}).
     */
    private boolean enviarPdfInterno(
            String destinatario,
            String nombreClienteRaw,
            byte[] pdf,
            String filename,
            String logContext,
            Function<String, PickingEmailEvent> sentFactory,
            BiFunction<String, String, PickingEmailEvent> failedFactory,
            BiFunction<String, String, PickingEmailEvent> ambiguoFactory,
            String operador) {
        try {
            MimeMessage mime = mailSender.createMimeMessage();
            MimeMessageHelper helper = new MimeMessageHelper(mime, true, "UTF-8");

            String from = StringUtils.hasText(emailFrom) ? emailFrom : mailUsername;
            if (StringUtils.hasText(from)) {
                helper.setFrom(from);
            }
            helper.setTo(destinatario.split("\\s*,\\s*"));
            helper.setSubject(SUBJECT);

            String nombreCliente = vacioOPlaceholder(nombreClienteRaw);
            helper.setText(plainBody(nombreCliente), htmlBody(escapeHtml(nombreCliente)));
            helper.addAttachment(filename, new ByteArrayResource(pdf));

            log.info("Email {} — enviando a {} PDF={}KB", logContext, destinatario, pdf.length / 1024);
            mailSender.send(mime);
            log.info("Email enviado a {} para {}", destinatario, logContext);
            publicarEvento(operador, sentFactory.apply(destinatario));
            return true;
        } catch (Exception e) {
            if (esReadTimeoutPostUpload(e)) {
                // Gmail aceptó los datos pero el 250 OK no llegó antes de que la
                // conexión se cortara. Con PDFs grandes (varios MB) el ACK final
                // suele tardar y algún NAT/firewall intermedio cierra el socket —
                // el mail muy probablemente quedó encolado en Gmail. No es un
                // error técnico que requiera reintento ciego, así que lo bajamos
                // a WARN y notificamos al operador con un toast diferente.
                log.warn("Email {} — Read timed out esperando ACK de Gmail (PDF={}KB). "
                        + "El mail probablemente se entregó: {}",
                        logContext, pdf.length / 1024, e.getMessage());
                String detalle = "Gmail tardó en confirmar el envío. El mail probablemente llegó — "
                        + "verificá la bandeja del cliente antes de reintentar.";
                publicarEvento(operador, ambiguoFactory.apply(destinatario, detalle));
                return false;
            }
            log.error("Falló envío de email para {}: {}", logContext, e.getMessage(), e);
            String detalle = UserMessages.traducir(e,
                    "No se pudo enviar el email. Revisar logs del backend para más detalle.");
            publicarEvento(operador, failedFactory.apply(destinatario, detalle));
            return false;
        }
    }

    /** True si la causa raíz es un {@link SocketTimeoutException} — típico cuando
     *  el adjunto se subió OK pero Gmail no mandó el {@code 250 OK} a tiempo. */
    private static boolean esReadTimeoutPostUpload(Throwable t) {
        for (Throwable cur = t; cur != null; cur = cur.getCause()) {
            if (cur instanceof SocketTimeoutException) return true;
        }
        return false;
    }

    /**
     * Llama al supplier del PDF capturando excepciones de generación —
     * publica FAILED si revienta. Devuelve {@code null} si el supplier
     * devolvió null (caso legítimo: no hay items que mandar — el caller
     * decide cómo manejarlo).
     */
    private byte[] generarPdfSeguro(
            java.util.function.Supplier<byte[]> pdfSupplier,
            String logContext,
            String destinatario,
            BiFunction<String, String, PickingEmailEvent> failedFactory,
            String operador) {
        try {
            return pdfSupplier.get();
        } catch (Exception ex) {
            log.warn("No se pudo generar el PDF de historial para {}: {}", logContext, ex.getMessage(), ex);
            String detalle = UserMessages.traducir(ex, "No se pudo generar el PDF de follow-up.");
            publicarEvento(operador, failedFactory.apply(destinatario, detalle));
            return null;
        }
    }

    // =====================================================
    // Plantillas del cuerpo (plain + html)
    // =====================================================

    private static String plainBody(String nombreCliente) {
        return """
                Hola %s,

                Gracias por tu visita al showroom de KT GASTRO. En este email
                te dejamos un PDF con los productos que estuviste mirando, para
                que los tengas a mano si querés consultarlos más adelante.

                Cualquier consulta, estamos a disposición.

                Saludos,
                Equipo KT GASTRO
                """.formatted(nombreCliente);
    }

    private static String htmlBody(String nombreClienteEscapado) {
        return """
                <div style="font-family: Arial, Helvetica, sans-serif; color: #2d2d2d; max-width: 600px;">
                  <h2 style="color: #FF861C; margin: 0 0 16px 0; font-size: 20px;">
                    ¡Gracias por tu visita, %s!
                  </h2>
                  <p style="font-size: 14px; line-height: 1.6;">
                    Te dejamos un <strong>PDF con los productos que estuviste mirando</strong>
                    en el showroom — para que los tengas a mano si querés consultarlos
                    más adelante.
                  </p>
                  <p style="font-size: 14px; line-height: 1.6;">
                    Cualquier consulta, estamos a disposición.
                  </p>
                  <p style="font-size: 14px; color: #5a5a5a; margin-top: 24px;">
                    Saludos,<br>
                    <strong style="color: #FF861C;">Equipo KT GASTRO</strong>
                  </p>
                </div>
                """.formatted(nombreClienteEscapado);
    }

    // =====================================================
    // Helpers
    // =====================================================

    private static String cuitDe(PedidoShowroom pedido) {
        return pedido.getNroDoc() != null ? String.valueOf(pedido.getNroDoc()) : null;
    }

    /** Devuelve "—" si el string es null/blank, sino el valor trimmed. */
    private static String vacioOPlaceholder(String s) {
        return (s == null || s.isBlank()) ? "—" : s.trim();
    }

    /** Escape mínimo para evitar HTML injection en nombres con caracteres especiales. */
    private static String escapeHtml(String s) {
        if (s == null) return "";
        return s.replace("&", "&amp;")
                .replace("<", "&lt;")
                .replace(">", "&gt;")
                .replace("\"", "&quot;");
    }
}
