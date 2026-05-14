package ar.com.leo.showroom.picking;

import ar.com.leo.showroom.catalogo.repository.LocalidadRepository;
import ar.com.leo.showroom.catalogo.repository.ProvinciaRepository;
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

import java.math.BigDecimal;
import java.text.NumberFormat;
import java.util.Locale;
import java.util.Optional;

/**
 * Envía el presupuesto PDF por email al destinatario configurado desde la
 * pantalla /configuracion (tabla {@code configuracion}, clave
 * {@code picking.email-to}). Se invoca async después de cada pedido exitoso
 * para no bloquear la respuesta al frontend, y también se puede disparar
 * manualmente desde el endpoint `POST /pedidos/{id}/email`.
 *
 * <p>La generación del pickit externo es independiente — la dispara
 * {@code ShowroomService.crearPedido} en paralelo con este envío para que el
 * operador reciba el .xlsx en su browser sin esperar a que termine el SMTP.</p>
 *
 * Si {@code showroom.picking.email-enabled=false} o falta destinatario,
 * loguea un warn y no manda nada (no rompe el flujo del pedido). El
 * controller usa {@link #motivoNoConfigurado()} para responder con 503
 * al disparo manual.
 *
 * Tras el envío, se publica un evento SSE "picking-email" (SENT/FAILED)
 * para que el frontend muestre toast de confirmación.
 */
@Slf4j
@Service
public class PickingEmailService {

    private static final NumberFormat PESO_FMT;
    static {
        PESO_FMT = NumberFormat.getCurrencyInstance(Locale.of("es", "AR"));
        PESO_FMT.setMaximumFractionDigits(0);
        PESO_FMT.setMinimumFractionDigits(0);
    }

    private final PresupuestoPdfGenerator pdfGenerator;
    private final JavaMailSender mailSender;
    private final SyncEventService eventService;
    private final ProvinciaRepository provinciaRepository;
    private final LocalidadRepository localidadRepository;
    private final SesionShowroomRepository sesionRepository;

    @Value("${showroom.picking.email-enabled:false}")
    private boolean enabled;

    @Value("${showroom.picking.email-from:}")
    private String emailFrom;

    @Value("${spring.mail.username:}")
    private String mailUsername;

    /**
     * Spring boot autoconfigura JavaMailSender solo si hay config SMTP. Si no hay,
     * el bean podría ser null o un dummy. Lo recibimos via @Autowired-required=false.
     */
    public PickingEmailService(
            PresupuestoPdfGenerator pdfGenerator,
            org.springframework.beans.factory.ObjectProvider<JavaMailSender> mailSender,
            SyncEventService eventService,
            ProvinciaRepository provinciaRepository,
            LocalidadRepository localidadRepository,
            SesionShowroomRepository sesionRepository) {
        this.pdfGenerator = pdfGenerator;
        this.mailSender = mailSender.getIfAvailable();
        this.eventService = eventService;
        this.provinciaRepository = provinciaRepository;
        this.localidadRepository = localidadRepository;
        this.sesionRepository = sesionRepository;
    }

    /**
     * Devuelve el motivo por el cual el envío de email no es posible (a nivel
     * sistema), o vacío si está todo configurado. Lo usa el controller para
     * responder al disparo manual con un mensaje claro en lugar de fallar
     * silenciosamente.
     *
     * <p>NOTA: el destinatario sale ahora del {@code pedido.email} (cliente),
     * no de una config global. La validación del email por pedido se hace
     * dentro de {@link #enviarAsync(PedidoShowroom)} y no es chequeable acá
     * (no tenemos contexto del pedido).
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

    @Async
    public void enviarAsync(PedidoShowroom pedido) {
        if (!enabled) {
            log.debug("Email deshabilitado (showroom.picking.email-enabled=false). Pedido {} no se envía.", pedido.getId());
            return;
        }
        if (mailSender == null) {
            log.warn("Email enabled pero JavaMailSender no está configurado (revisar spring.mail.* en application.properties).");
            return;
        }
        String emailCliente = pedido.getEmail();
        if (!StringUtils.hasText(emailCliente)) {
            log.warn("Pedido {} sin email del cliente — no se manda el follow-up.", pedido.getId());
            return;
        }

        // El PDF que se manda al cliente es el "scan history" — productos que
        // miró pero no compró. Si no hay sesión asociada (operador no inició
        // una) o no quedan items luego de filtrar lo comprado, no hay nada que
        // mandar.
        Optional<SesionShowroom> sesionOpt = sesionRepository.findByPedidoIdWithItems(pedido.getId());
        if (sesionOpt.isEmpty()) {
            log.info("Pedido {} sin sesión asociada — no se manda email de follow-up.", pedido.getId());
            return;
        }
        byte[] pdf;
        try {
            pdf = pdfGenerator.generarHistorial(sesionOpt.get(), pedido);
        } catch (Exception ex) {
            log.warn("No se pudo generar el PDF de historial para pedido {}: {}", pedido.getId(), ex.getMessage(), ex);
            String detalle = UserMessages.traducir(ex,
                    "No se pudo generar el PDF de follow-up.");
            eventService.publish("picking-email",
                    PickingEmailEvent.failed(pedido.getId(), cuitDe(pedido), detalle));
            return;
        }
        if (pdf == null) {
            log.info("Pedido {} — el cliente compró todo lo que vio, no hay items extra para mandar.", pedido.getId());
            return;
        }

        try {
            MimeMessage mime = mailSender.createMimeMessage();
            MimeMessageHelper helper = new MimeMessageHelper(mime, true, "UTF-8");

            String from = StringUtils.hasText(emailFrom) ? emailFrom : mailUsername;
            if (StringUtils.hasText(from)) {
                helper.setFrom(from);
            }
            helper.setTo(emailCliente.split("\\s*,\\s*"));
            String nombreCliente = vacioOPlaceholder(pedido.getNombreCompleto());
            helper.setSubject("KT GASTRO — Productos que viste en el showroom");

            // Cuerpo del email — corto y client-facing. El PDF tiene el detalle.
            String plain = """
                    Hola %s,

                    Gracias por tu visita al showroom de KT GASTRO. En este email
                    te dejamos un PDF con los productos que estuviste mirando y que
                    todavía no te llevaste — para que los tengas a mano si querés
                    consultarlos más adelante.

                    Cualquier consulta, estamos a disposición.

                    Saludos,
                    Equipo KT GASTRO
                    """.formatted(nombreCliente);

            String htmlText = """
                    <div style="font-family: Arial, Helvetica, sans-serif; color: #2d2d2d; max-width: 600px;">
                      <h2 style="color: #FF861C; margin: 0 0 16px 0; font-size: 20px;">
                        ¡Gracias por tu visita, %s!
                      </h2>
                      <p style="font-size: 14px; line-height: 1.6;">
                        Te dejamos un <strong>PDF con los productos que estuviste mirando</strong>
                        en el showroom y que todavía no te llevaste — para que los tengas
                        a mano si querés consultarlos más adelante.
                      </p>
                      <p style="font-size: 14px; line-height: 1.6;">
                        Cualquier consulta, estamos a disposición.
                      </p>
                      <p style="font-size: 14px; color: #5a5a5a; margin-top: 24px;">
                        Saludos,<br>
                        <strong style="color: #FF861C;">Equipo KT GASTRO</strong>
                      </p>
                    </div>
                    """.formatted(escapeHtml(nombreCliente));

            helper.setText(plain, htmlText);

            String nombrePdf = pdfGenerator.nombreArchivo(pedido);
            helper.addAttachment(nombrePdf, new ByteArrayResource(pdf));

            log.info("Email pedido {} — enviando a {} PDF={}KB", pedido.getId(), emailCliente, pdf.length / 1024);
            mailSender.send(mime);
            log.info("Email enviado a {} para pedido {}", emailCliente, pedido.getId());
            eventService.publish("picking-email",
                    PickingEmailEvent.sent(pedido.getId(), cuitDe(pedido)));
        } catch (Exception e) {
            // No tirar la excepción — el pedido ya está creado en DUX, no podemos
            // revertirlo si el email falla. Solo logueamos y notificamos al frontend.
            log.error("Falló envío de email para pedido {}: {}", pedido.getId(), e.getMessage(), e);
            String detalle = UserMessages.traducir(e,
                    "No se pudo enviar el email. Revisar logs del backend para más detalle.");
            eventService.publish("picking-email",
                    PickingEmailEvent.failed(pedido.getId(), cuitDe(pedido), detalle));
        }
    }

    private static String cuitDe(PedidoShowroom pedido) {
        return pedido.getNroDoc() != null ? String.valueOf(pedido.getNroDoc()) : null;
    }

    private static String formatPesos(BigDecimal v) {
        return v != null ? PESO_FMT.format(v.doubleValue()) : "—";
    }

    private static BigDecimal aplicarDescuento(BigDecimal valor, BigDecimal porcentaje) {
        if (valor == null) return null;
        if (porcentaje == null || porcentaje.signum() <= 0) return valor;
        BigDecimal factor = BigDecimal.ONE.subtract(porcentaje.movePointLeft(2));
        return valor.multiply(factor);
    }

    /** Formatea el porcentaje sin decimales innecesarios: 5 → "5", 5.5 → "5,5". */
    private static String formatPorcentaje(BigDecimal pct) {
        BigDecimal stripped = pct.stripTrailingZeros();
        if (stripped.scale() <= 0) return stripped.toPlainString();
        return stripped.toPlainString().replace('.', ',');
    }

    /** Fila label/value de la tabla del mail (value puede contener HTML inline). */
    private static String filaHtml(String label, String value) {
        return """
                <tr>
                  <td style="padding: 4px 16px 4px 0; color: #666;">%s</td>
                  <td style="padding: 4px 0;"><strong>%s</strong></td>
                </tr>
                """.formatted(label, value);
    }

    /** Devuelve "—" si el string es null/blank, sino el valor trimmed. */
    private static String vacioOPlaceholder(String s) {
        return (s == null || s.isBlank()) ? "—" : s.trim();
    }

    /** Resuelve el nombre de la provincia desde su cod_iso (ej. "B" → "BUENOS AIRES"). */
    private String resolverProvinciaNombre(String codIso) {
        if (codIso == null || codIso.isBlank()) return null;
        return provinciaRepository.findByCodIsoIgnoreCase(codIso)
                .map(prov -> "C".equalsIgnoreCase(prov.getCodIso())
                        ? prov.getNombre() + " (CABA)"
                        : prov.getNombre())
                .orElse(null);
    }

    /** Resuelve el nombre de la localidad desde su id (string). */
    private String resolverLocalidadNombre(String idStr) {
        if (idStr == null || idStr.isBlank()) return null;
        try {
            Long id = Long.valueOf(idStr);
            return localidadRepository.findById(id)
                    .map(loc -> loc.getNombre())
                    .orElse(null);
        } catch (NumberFormatException e) {
            return null;
        }
    }

    /** Escape mínimo para evitar HTML injection en observaciones libres del operador. */
    private static String escapeHtml(String s) {
        if (s == null) return "";
        return s.replace("&", "&amp;")
                .replace("<", "&lt;")
                .replace(">", "&gt;")
                .replace("\"", "&quot;");
    }
}
