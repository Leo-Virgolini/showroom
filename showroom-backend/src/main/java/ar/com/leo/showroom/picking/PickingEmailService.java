package ar.com.leo.showroom.picking;

import ar.com.leo.showroom.catalogo.repository.LocalidadRepository;
import ar.com.leo.showroom.catalogo.repository.ProvinciaRepository;
import ar.com.leo.showroom.events.PickingEmailEvent;
import ar.com.leo.showroom.events.SyncEventService;
import ar.com.leo.showroom.pedido.entity.PedidoShowroom;
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
 * Envía el XLSX de picking + presupuesto PDF por email al destinatario
 * configurado en `showroom.picking.email-to`. Se invoca async después de
 * cada pedido exitoso para no bloquear la respuesta al frontend, y también
 * se puede disparar manualmente desde el endpoint `POST /pedidos/{id}/email`.
 *
 * Si {@code showroom.picking.email-enabled=false} o falta config, loguea
 * un warn y no manda nada (no rompe el flujo del pedido). El controller
 * usa {@link #motivoNoConfigurado()} para responder con 503 al disparo manual.
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

    private final PickingExcelGenerator excelGenerator;
    private final PresupuestoPdfGenerator pdfGenerator;
    private final JavaMailSender mailSender;
    private final SyncEventService eventService;
    private final ProvinciaRepository provinciaRepository;
    private final LocalidadRepository localidadRepository;

    @Value("${showroom.picking.email-enabled:false}")
    private boolean enabled;

    @Value("${showroom.picking.email-to:}")
    private String emailTo;

    @Value("${showroom.picking.email-from:}")
    private String emailFrom;

    @Value("${spring.mail.username:}")
    private String mailUsername;

    /**
     * Spring boot autoconfigura JavaMailSender solo si hay config SMTP. Si no hay,
     * el bean podría ser null o un dummy. Lo recibimos via @Autowired-required=false.
     */
    public PickingEmailService(
            PickingExcelGenerator excelGenerator,
            PresupuestoPdfGenerator pdfGenerator,
            org.springframework.beans.factory.ObjectProvider<JavaMailSender> mailSender,
            SyncEventService eventService,
            ProvinciaRepository provinciaRepository,
            LocalidadRepository localidadRepository) {
        this.excelGenerator = excelGenerator;
        this.pdfGenerator = pdfGenerator;
        this.mailSender = mailSender.getIfAvailable();
        this.eventService = eventService;
        this.provinciaRepository = provinciaRepository;
        this.localidadRepository = localidadRepository;
    }

    /**
     * Devuelve el motivo por el cual el envío de email no es posible, o vacío si
     * está todo configurado. Lo usa el controller para responder al disparo
     * manual con un mensaje claro en lugar de fallar silenciosamente.
     */
    public Optional<String> motivoNoConfigurado() {
        if (!enabled) {
            return Optional.of("Picking email deshabilitado en config (showroom.picking.email-enabled=false)");
        }
        if (mailSender == null) {
            return Optional.of("JavaMailSender no configurado (revisar spring.mail.* en application.properties)");
        }
        if (!StringUtils.hasText(emailTo)) {
            return Optional.of("Falta destinatario (showroom.picking.email-to vacío)");
        }
        return Optional.empty();
    }

    @Async
    public void enviarAsync(PedidoShowroom pedido) {
        if (!enabled) {
            log.debug("Picking email deshabilitado (showroom.picking.email-enabled=false). Pedido {} no se envía.", pedido.getId());
            return;
        }
        if (mailSender == null) {
            log.warn("Picking email enabled pero JavaMailSender no está configurado (revisar spring.mail.* en application.properties).");
            return;
        }
        if (!StringUtils.hasText(emailTo)) {
            log.warn("Picking email enabled pero `showroom.picking.email-to` está vacío. Pedido {} no se envía.", pedido.getId());
            return;
        }

        try {
            byte[] xlsx = excelGenerator.generar(pedido);
            String nombreArchivo = excelGenerator.nombreArchivo(pedido);

            MimeMessage mime = mailSender.createMimeMessage();
            MimeMessageHelper helper = new MimeMessageHelper(mime, true, "UTF-8");

            String from = StringUtils.hasText(emailFrom) ? emailFrom : mailUsername;
            if (StringUtils.hasText(from)) {
                helper.setFrom(from);
            }
            helper.setTo(emailTo.split("\\s*,\\s*"));
            String identificador = pedido.getNroDoc() != null
                    ? "CUIT " + pedido.getNroDoc()
                    : "#" + pedido.getId();
            helper.setSubject("Picking pedido showroom " + identificador
                    + " - " + pedido.getItems().size() + " items");

            String idLocal = String.valueOf(pedido.getId());
            String razonSocial = vacioOPlaceholder(pedido.getNombreCompleto());
            String cuit = pedido.getNroDoc() != null ? String.valueOf(pedido.getNroDoc()) : "—";
            String emailCliente = vacioOPlaceholder(pedido.getEmail());
            String telefono = vacioOPlaceholder(pedido.getTelefono());
            String domicilio = vacioOPlaceholder(pedido.getDomicilio());
            String provincia = vacioOPlaceholder(resolverProvinciaNombre(pedido.getCodigoProvincia()));
            String localidad = vacioOPlaceholder(resolverLocalidadNombre(pedido.getIdLocalidad()));
            String items = String.valueOf(pedido.getItems().size());

            BigDecimal totalSinIvaBruto = pedido.getTotalSinIva();
            BigDecimal totalConIvaBruto = pedido.getTotal();
            BigDecimal descPct = pedido.getDescuentoPorcentaje();
            BigDecimal totalSinIvaFinal = aplicarDescuento(totalSinIvaBruto, descPct);
            BigDecimal totalConIvaFinal = aplicarDescuento(totalConIvaBruto, descPct);
            BigDecimal ahorro = (totalSinIvaBruto != null && totalSinIvaFinal != null)
                    ? totalSinIvaBruto.subtract(totalSinIvaFinal)
                    : null;
            boolean hayDescuento = descPct != null && descPct.signum() > 0 && ahorro != null;

            String subtotalSinIva = formatPesos(totalSinIvaBruto);
            String totalSinIva = formatPesos(totalSinIvaFinal);
            String totalConIva = formatPesos(totalConIvaFinal);
            String descuentoLinea = hayDescuento
                    ? formatPorcentaje(descPct) + "% (−" + formatPesos(ahorro) + ")"
                    : null;
            String observaciones = pedido.getObservaciones();
            boolean hayObservaciones = observaciones != null && !observaciones.isBlank();

            // ----- Texto plano -----
            StringBuilder plain = new StringBuilder()
                    .append("Pedido del showroom listo para picking.\n\n")
                    .append("=== CLIENTE ===\n")
                    .append("Razón social: ").append(razonSocial).append('\n')
                    .append("CUIT: ").append(cuit).append('\n')
                    .append("Email: ").append(emailCliente).append('\n')
                    .append("Teléfono: ").append(telefono).append('\n')
                    .append("Domicilio (entrega): ").append(domicilio).append('\n')
                    .append("Provincia: ").append(provincia).append('\n')
                    .append("Localidad: ").append(localidad).append('\n')
                    .append('\n')
                    .append("=== PEDIDO ===\n")
                    .append("ID local: ").append(idLocal).append('\n')
                    .append("Items: ").append(items).append('\n')
                    .append("Subtotal (s/IVA): ").append(subtotalSinIva).append('\n');
            if (hayDescuento) {
                plain.append("Descuento: ").append(descuentoLinea).append('\n');
            }
            plain.append("Total final (s/IVA): ").append(totalSinIva).append('\n')
                    .append("Total final (c/IVA): ").append(totalConIva).append('\n');
            if (hayObservaciones) {
                plain.append('\n')
                        .append("Observaciones:\n")
                        .append(observaciones).append('\n');
            }
            plain.append('\n')
                    .append("Adjuntos:\n")
                    .append(" - XLSX (SKU, Cantidad): input para el sistema de picking.\n")
                    .append(" - PDF: presupuesto para mandarle al cliente.\n");

            // ----- HTML: dos tablas (Cliente + Pedido) -----
            StringBuilder filasCliente = new StringBuilder();
            filasCliente.append(filaHtml("Razón social", razonSocial));
            filasCliente.append(filaHtml("CUIT", cuit));
            filasCliente.append(filaHtml("Email", emailCliente));
            filasCliente.append(filaHtml("Teléfono", telefono));
            filasCliente.append(filaHtml("Domicilio (entrega)", domicilio));
            filasCliente.append(filaHtml("Provincia", provincia));
            filasCliente.append(filaHtml("Localidad", localidad));

            StringBuilder filasPedido = new StringBuilder();
            filasPedido.append(filaHtml("ID local", idLocal));
            filasPedido.append(filaHtml("Items", items));
            filasPedido.append(filaHtml("Subtotal (s/IVA)", subtotalSinIva));
            if (hayDescuento) {
                filasPedido.append(filaHtml("Descuento",
                        "<span style=\"color:#107A57;\">" + descuentoLinea + "</span>"));
            }
            filasPedido.append(filaHtml("Total final (s/IVA)",
                    "<span style=\"color:#FF861C;\">" + totalSinIva + "</span>"));
            filasPedido.append(filaHtml("Total final (c/IVA)", totalConIva));

            String observacionesHtml = hayObservaciones
                    ? """
                    <h3 style="color: #5a5a5a; margin: 20px 0 6px 0; font-size: 14px; text-transform: uppercase; letter-spacing: 1px;">Observaciones</h3>
                    <p style="margin: 0 0 16px 0; padding: 10px; background: #f5f5f5; border-left: 3px solid #FF861C; font-size: 14px; white-space: pre-wrap;">%s</p>
                    """.formatted(escapeHtml(observaciones))
                    : "";

            String htmlText = """
                    <div style="font-family: Arial, Helvetica, sans-serif; color: #2d2d2d; max-width: 600px;">
                      <h2 style="color: #FF861C; margin: 0 0 16px 0; font-size: 18px;">
                        Pedido del showroom listo para picking
                      </h2>

                      <h3 style="color: #5a5a5a; margin: 0 0 6px 0; font-size: 14px; text-transform: uppercase; letter-spacing: 1px;">Cliente</h3>
                      <table style="border-collapse: collapse; margin: 0 0 20px 0; font-size: 14px;">
                        %s
                      </table>

                      <h3 style="color: #5a5a5a; margin: 0 0 6px 0; font-size: 14px; text-transform: uppercase; letter-spacing: 1px;">Pedido</h3>
                      <table style="border-collapse: collapse; margin: 0 0 20px 0; font-size: 14px;">
                        %s
                      </table>

                      %s

                      <p style="margin: 0 0 6px 0; font-size: 14px;"><strong>Adjuntos</strong></p>
                      <ul style="margin: 0; padding-left: 20px; font-size: 14px; line-height: 1.6;">
                        <li><strong>XLSX</strong> (SKU, Cantidad) — input para el sistema de picking.</li>
                        <li><strong>PDF</strong> — presupuesto para mandarle al cliente.</li>
                      </ul>
                    </div>
                    """.formatted(filasCliente.toString(), filasPedido.toString(), observacionesHtml);

            helper.setText(plain.toString(), htmlText);

            helper.addAttachment(nombreArchivo, new ByteArrayResource(xlsx));

            // Adjuntamos también el presupuesto PDF (look-and-feel KT, para mandar
            // al cliente). Si la generación falla, seguimos solo con el XLSX —
            // el picking es lo crítico.
            try {
                byte[] pdf = pdfGenerator.generar(pedido);
                String nombrePdf = pdfGenerator.nombreArchivo(pedido);
                helper.addAttachment(nombrePdf, new ByteArrayResource(pdf));
            } catch (Exception ex) {
                log.warn("No se pudo adjuntar presupuesto PDF al pedido {}: {}", pedido.getId(), ex.getMessage());
            }

            mailSender.send(mime);
            log.info("Picking email enviado a {} para pedido {} ({})", emailTo, pedido.getId(), nombreArchivo);
            eventService.publish("picking-email",
                    PickingEmailEvent.sent(pedido.getId(), cuitDe(pedido)));
        } catch (Exception e) {
            // No tirar la excepción — el pedido ya está creado en DUX, no podemos
            // revertirlo si el email falla. Solo logueamos y notificamos al frontend.
            log.error("Falló envío de picking email para pedido {}: {}", pedido.getId(), e.getMessage(), e);
            eventService.publish("picking-email",
                    PickingEmailEvent.failed(pedido.getId(), cuitDe(pedido), e.getMessage()));
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
