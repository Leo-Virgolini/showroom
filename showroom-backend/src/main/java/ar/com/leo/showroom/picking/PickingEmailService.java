package ar.com.leo.showroom.picking;

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

    private final PresupuestoPdfGenerator pdfGenerator;
    private final JavaMailSender mailSender;
    private final SyncEventService eventService;
    private final SesionShowroomRepository sesionRepository;

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
            PresupuestoPdfGenerator pdfGenerator,
            org.springframework.beans.factory.ObjectProvider<JavaMailSender> mailSender,
            SyncEventService eventService,
            SesionShowroomRepository sesionRepository) {
        this.pdfGenerator = pdfGenerator;
        this.mailSender = mailSender.getIfAvailable();
        this.eventService = eventService;
        this.sesionRepository = sesionRepository;
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
        enviarPedidoSync(pedido); // fire-and-forget, ignora outcome
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

        byte[] pdf = generarPdfSeguro(
                () -> pdfGenerator.generarHistorial(sesion, pedido),
                "pedido " + pedido.getId(),
                emailCliente,
                failedFactory);
        if (pdf == null) {
            // Caso "no items extra" — el cliente compró todo lo que vio. No es
            // un error técnico, pero igual notificamos al frontend con SKIPPED
            // para que el operador (que tocó el botón manual) reciba un toast
            // claro en vez de quedar esperando.
            String motivo = "El cliente compró todo lo que vio — no hay PDF de productos extra para mandar.";
            log.info("Pedido {} — {}", pedido.getId(), motivo);
            eventService.publish(SSE_EVENT, PickingEmailEvent.skippedPedido(
                    pedido.getId(), cuit, emailCliente, motivo));
            return false;
        }

        return enviarPdfInterno(
                emailCliente,
                pedido.getNombreCompleto(),
                pdf,
                pdfGenerator.nombreArchivo(pedido),
                "pedido " + pedido.getId(),
                sentFactory,
                failedFactory);
    }

    /**
     * Mandado desde el botón ✉️ en /historial para sesiones ABANDONADAS. El
     * PDF incluye TODOS los items escaneados (no hay diff contra pedido).
     */
    @Async
    public void enviarPdfSesionAsync(SesionShowroom sesion, String emailDestinatario) {
        Function<String, PickingEmailEvent> sentFactory =
                emailDest -> PickingEmailEvent.sentSesion(sesion.getId(), emailDest);
        BiFunction<String, String, PickingEmailEvent> failedFactory =
                (emailDest, err) -> PickingEmailEvent.failedSesion(sesion.getId(), emailDest, err);

        Optional<String> motivo = motivoNoConfigurado();
        if (motivo.isPresent()) {
            log.debug("Email no disponible: {}. Sesión {} no se envía.", motivo.get(), sesion.getId());
            eventService.publish(SSE_EVENT, failedFactory.apply(emailDestinatario, motivo.get()));
            return;
        }
        if (!StringUtils.hasText(emailDestinatario)) {
            log.warn("Sesión {} sin email destinatario — no se manda email.", sesion.getId());
            eventService.publish(SSE_EVENT, failedFactory.apply(null, "Falta el email del cliente."));
            return;
        }

        byte[] pdf = generarPdfSeguro(
                () -> pdfGenerator.generarHistorialSesion(sesion),
                "sesión " + sesion.getId(),
                emailDestinatario,
                failedFactory);
        if (pdf == null) {
            log.info("Sesión {} sin items escaneados — no hay PDF que mandar.", sesion.getId());
            eventService.publish(SSE_EVENT, failedFactory.apply(emailDestinatario,
                    "La sesión no tiene items escaneados — no hay PDF que mandar."));
            return;
        }

        enviarPdfInterno(
                emailDestinatario,
                sesion.getNombre(),
                pdf,
                pdfGenerator.nombreArchivoSesion(sesion),
                "sesión " + sesion.getId(),
                sentFactory,
                failedFactory);
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
            BiFunction<String, String, PickingEmailEvent> failedFactory) {
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
            eventService.publish(SSE_EVENT, sentFactory.apply(destinatario));
            return true;
        } catch (Exception e) {
            log.error("Falló envío de email para {}: {}", logContext, e.getMessage(), e);
            String detalle = UserMessages.traducir(e,
                    "No se pudo enviar el email. Revisar logs del backend para más detalle.");
            eventService.publish(SSE_EVENT, failedFactory.apply(destinatario, detalle));
            return false;
        }
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
            BiFunction<String, String, PickingEmailEvent> failedFactory) {
        try {
            return pdfSupplier.get();
        } catch (Exception ex) {
            log.warn("No se pudo generar el PDF de historial para {}: {}", logContext, ex.getMessage(), ex);
            String detalle = UserMessages.traducir(ex, "No se pudo generar el PDF de follow-up.");
            eventService.publish(SSE_EVENT, failedFactory.apply(destinatario, detalle));
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
