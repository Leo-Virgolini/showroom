package ar.com.leo.showroom.cotizacion.service;

import ar.com.leo.showroom.common.exception.UserMessages;
import ar.com.leo.showroom.cotizacion.dto.GenerarCotizacionRequestDTO;
import ar.com.leo.showroom.events.SyncEventService;
import jakarta.mail.internet.MimeMessage;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Lazy;
import org.springframework.core.io.ByteArrayResource;
import org.springframework.mail.javamail.JavaMailSender;
import org.springframework.mail.javamail.MimeMessageHelper;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;

import java.math.BigDecimal;
import java.net.SocketTimeoutException;
import java.time.Instant;
import java.util.Map;
import java.util.Optional;

/**
 * Herramienta INSTANTÁNEA de cotización financiera: genera el PDF a partir del
 * payload recibido y lo devuelve / lo envía por email. NO persiste nada en BD
 * — no hay historial ni edición. Versión mucho más simple que
 * {@code PresupuestoComercialService}: sin items, sin descuentos por línea,
 * una sola hoja de PDF.
 */
@Slf4j
@Service
public class CotizacionFinancieraService {

    private static final String SSE_EVENT = "cotizacion-financiera-email";
    private static final String SUBJECT = "KT GASTRO — Cotización financiera";

    private final CotizacionFinancieraPdfGenerator pdfGenerator;
    private final JavaMailSender mailSender;
    private final SyncEventService eventService;

    /** Self-injection para que {@link #enviarPorEmailAsync} pase por el proxy
     *  de Spring y {@code @Async} efectivamente arme un thread separado.
     *  Mismo patrón que {@code PresupuestoComercialService.self}. */
    @Autowired
    @Lazy
    private CotizacionFinancieraService self;

    @Value("${showroom.picking.email-enabled:false}")
    private boolean emailEnabled;

    @Value("${showroom.picking.email-from:}")
    private String emailFrom;

    @Value("${spring.mail.username:}")
    private String mailUsername;

    public CotizacionFinancieraService(
            CotizacionFinancieraPdfGenerator pdfGenerator,
            ObjectProvider<JavaMailSender> mailSender,
            SyncEventService eventService) {
        this.pdfGenerator = pdfGenerator;
        this.mailSender = mailSender.getIfAvailable();
        this.eventService = eventService;
    }

    private void publicarEvento(String operador, Object payload) {
        if (operador != null) {
            eventService.publishTo(operador, SSE_EVENT, payload);
        } else {
            eventService.publish(SSE_EVENT, payload);
        }
    }

    /**
     * Genera el PDF de la cotización SIN persistir. Valida que al menos uno de
     * los dos montos sea {@code > 0} — si ambos vienen null/cero lanza
     * {@link IllegalArgumentException}.
     */
    public Resultado generar(GenerarCotizacionRequestDTO datos, String username) {
        validarMontos(datos);
        Instant emitidoAt = Instant.now();
        byte[] pdf = pdfGenerator.generar(datos, emitidoAt);
        return new Resultado(pdf, pdfGenerator.nombreArchivo(datos, emitidoAt));
    }

    /** Genera el PDF (sin persistir) y dispara el envío async por email. */
    public void generarYEnviarPorEmail(String destinatario,
                                       GenerarCotizacionRequestDTO datos,
                                       String username) {
        Resultado r = generar(datos, username);
        self.enviarPorEmailAsync(destinatario, datos.clienteNombre(),
                r.pdf(), r.nombreArchivo(), username);
    }

    /** Valida que al menos uno de los dos montos (con IVA) sea > 0. El
     *  {@code @PositiveOrZero} del DTO no alcanza porque ambos son
     *  independientes y opcionales. */
    private void validarMontos(GenerarCotizacionRequestDTO datos) {
        BigDecimal monto1 = datos.montoBaseConIva();
        BigDecimal monto2 = datos.montoBaseConIva2();
        boolean tieneMonto1 = monto1 != null && monto1.signum() > 0;
        boolean tieneMonto2 = monto2 != null && monto2.signum() > 0;
        if (!tieneMonto1 && !tieneMonto2) {
            throw new IllegalArgumentException(
                    "Tenés que ingresar al menos uno de los dos montos para cotizar");
        }
    }

    public Optional<String> motivoEmailNoConfigurado() {
        if (!emailEnabled) {
            return Optional.of("Envío de email deshabilitado (showroom.picking.email-enabled=false)");
        }
        if (mailSender == null) {
            return Optional.of("JavaMailSender no configurado (revisar spring.mail.* en application.properties)");
        }
        return Optional.empty();
    }

    /** Public + invocado vía {@link #self} para que el aspect de @Async corra
     *  en thread aparte (el envío del PDF por SMTP puede tardar varios
     *  segundos y no debe bloquear la respuesta HTTP). */
    @Async
    public void enviarPorEmailAsync(String destinatario, String nombreCliente,
                                    byte[] pdf, String filename, String operador) {
        try {
            MimeMessage mime = mailSender.createMimeMessage();
            MimeMessageHelper helper = new MimeMessageHelper(mime, true, "UTF-8");

            String from = StringUtils.hasText(emailFrom) ? emailFrom : mailUsername;
            if (StringUtils.hasText(from)) helper.setFrom(from);
            helper.setTo(destinatario.split("\\s*,\\s*"));
            helper.setSubject(SUBJECT);

            String nombre = StringUtils.hasText(nombreCliente) ? nombreCliente : "Cliente";
            helper.setText(plainBody(nombre), htmlBody(escapeHtml(nombre)));
            helper.addAttachment(filename, new ByteArrayResource(pdf));

            log.info("Email cotización → {} ({} KB)", destinatario, pdf.length / 1024);
            mailSender.send(mime);
            publicarEvento(operador, Map.of(
                    "estado", "SENT",
                    "email", destinatario));
        } catch (Exception e) {
            if (esReadTimeoutPostUpload(e)) {
                log.warn("Email cotización — Read timed out esperando ACK de Gmail "
                        + "(PDF={}KB). El mail probablemente se entregó: {}",
                        pdf.length / 1024, e.getMessage());
                publicarEvento(operador, Map.of(
                        "estado", "AMBIGUO",
                        "email", destinatario,
                        "error", "Gmail tardó en confirmar. El mail probablemente llegó."));
                return;
            }
            log.error("Falló envío de email de la cotización: {}", e.getMessage(), e);
            String detalle = UserMessages.traducir(e,
                    "No se pudo enviar el email. Revisar logs del backend.");
            publicarEvento(operador, Map.of(
                    "estado", "FAILED",
                    "email", destinatario,
                    "error", detalle));
        }
    }

    private static boolean esReadTimeoutPostUpload(Throwable t) {
        for (Throwable cur = t; cur != null; cur = cur.getCause()) {
            if (cur instanceof SocketTimeoutException) return true;
        }
        return false;
    }

    private static String plainBody(String nombre) {
        return """
                Hola %s,

                Te dejamos adjunta la cotización financiera que armamos en KT GASTRO.

                Cualquier consulta, estamos a disposición.

                Saludos,
                Equipo KT GASTRO
                """.formatted(nombre);
    }

    private static String htmlBody(String nombreEscapado) {
        return """
                <div style="font-family: Arial, Helvetica, sans-serif; color: #2d2d2d; max-width: 600px;">
                  <h2 style="color: #FF861C; margin: 0 0 16px 0; font-size: 20px;">
                    Hola %s,
                  </h2>
                  <p style="font-size: 14px; line-height: 1.6;">
                    Te dejamos adjunta la <strong>cotización financiera</strong> que
                    armamos para vos en KT GASTRO, con el detalle de las formas de pago
                    disponibles y su precio final.
                  </p>
                  <p style="font-size: 14px; line-height: 1.6;">
                    Cualquier consulta, estamos a disposición.
                  </p>
                  <p style="font-size: 14px; color: #5a5a5a; margin-top: 24px;">
                    Saludos,<br>
                    <strong style="color: #FF861C;">Equipo KT GASTRO</strong>
                  </p>
                </div>
                """.formatted(nombreEscapado);
    }

    private static String escapeHtml(String s) {
        if (s == null) return "";
        return s.replace("&", "&amp;")
                .replace("<", "&lt;").replace(">", "&gt;")
                .replace("\"", "&quot;");
    }

    /** Resultado del generar — PDF + filename. */
    public record Resultado(byte[] pdf, String nombreArchivo) {}
}
