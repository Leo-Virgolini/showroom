package ar.com.leo.showroom.presupuesto.service;

import ar.com.leo.showroom.common.exception.NotFoundException;
import ar.com.leo.showroom.common.exception.UserMessages;
import ar.com.leo.showroom.events.SyncEventService;
import ar.com.leo.showroom.presupuesto.dto.GenerarPresupuestoRequestDTO;
import ar.com.leo.showroom.presupuesto.dto.PresupuestoListItemDTO;
import ar.com.leo.showroom.presupuesto.dto.PresupuestoListPageDTO;
import ar.com.leo.showroom.presupuesto.entity.PresupuestoComercial;
import ar.com.leo.showroom.presupuesto.repository.PresupuestoComercialRepository;
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
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.StringUtils;
import tools.jackson.databind.ObjectMapper;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * Orquesta el ciclo de vida del presupuesto comercial: calcula totales,
 * persiste la cabecera solo cuando se envía al cliente (preview es transitorio
 * para no quemar números) y dispara el envío del email en background.
 *
 * <p>NO se manda nada a DUX — el presupuesto es 100% local y sirve como
 * pieza comercial previa al pedido.
 */
@Slf4j
@Service
public class PresupuestoComercialService {

    private static final String SSE_EVENT = "presupuesto-comercial-email";
    private static final String SUBJECT = "KT GASTRO — Presupuesto #";

    private final PresupuestoComercialRepository repository;
    private final PresupuestoComercialPdfGenerator pdfGenerator;
    private final JavaMailSender mailSender;
    private final SyncEventService eventService;
    private final ObjectMapper mapper;

    /**
     * Self-injection para que {@link #enviarPorEmailAsync} (anotado {@code @Async})
     * pase por el proxy de Spring cuando se invoca desde {@link #generarYEnviarPorEmail}.
     * Sin esto, la llamada {@code this.enviarPorEmailAsync(...)} es self-invocation
     * y el aspect de async se ignora — el envío corre sincrónicamente bloqueando
     * el thread HTTP del controller. Mismo patrón que {@code CatalogoSyncService.self}.
     */
    @Autowired
    @Lazy
    private PresupuestoComercialService self;

    @Value("${showroom.picking.email-enabled:false}")
    private boolean emailEnabled;

    @Value("${showroom.picking.email-from:}")
    private String emailFrom;

    @Value("${spring.mail.username:}")
    private String mailUsername;

    public PresupuestoComercialService(
            PresupuestoComercialRepository repository,
            PresupuestoComercialPdfGenerator pdfGenerator,
            ObjectProvider<JavaMailSender> mailSender,
            SyncEventService eventService,
            ObjectMapper mapper) {
        this.repository = repository;
        this.pdfGenerator = pdfGenerator;
        this.mailSender = mailSender.getIfAvailable();
        this.eventService = eventService;
        this.mapper = mapper;
    }

    /**
     * Persiste el presupuesto (asigna número), genera el PDF y devuelve el
     * resultado SIN enviar email. Usado por el botón "Descargar PDF" del
     * frontend para que el operador pueda mandar el archivo manualmente al
     * cliente (WhatsApp/email/etc.) con un número definitivo.
     *
     * <p>Cada llamada genera UN número nuevo en BD. Si el operador toca el
     * botón varias veces se gastan números — trade-off aceptado a cambio de
     * tener PDFs listos para enviar sin paso intermedio.
     */
    @Transactional
    public Resultado generarYPersistir(GenerarPresupuestoRequestDTO datos) {
        PresupuestoComercial p = construirEntidad(datos);
        p = repository.save(p);
        byte[] pdf = pdfGenerator.generar(p, datos);
        return new Resultado(p, pdf, pdfGenerator.nombreArchivo(p));
    }

    /**
     * Crea el presupuesto en BD (asigna número), genera el PDF y dispara el
     * envío del email en background. Devuelve el {@link Resultado} con el ID
     * generado para que el controller lo informe al frontend; el resultado
     * real del envío llega vía SSE {@code presupuesto-comercial-email}.
     */
    @Transactional
    public Resultado generarYEnviarPorEmail(String destinatario,
                                            GenerarPresupuestoRequestDTO datos) {
        Resultado r = generarYPersistir(datos);
        // self.* atraviesa el proxy de Spring para que @Async funcione.
        self.enviarPorEmailAsync(destinatario, r.presupuesto().getId(),
                r.presupuesto().getClienteNombre(), r.pdf(), r.nombreArchivo());
        return r;
    }

    public PresupuestoComercial obtener(Long id) {
        return repository.findById(id)
                .orElseThrow(() -> new NotFoundException("Presupuesto comercial no encontrado: " + id));
    }

    /**
     * Lista paginada para la pantalla de historial. Soporta filtros por
     * texto libre (nombre/email/teléfono), rango de fechas e id puntual
     * (deep-link). Orden default: más recientes primero.
     */
    public PresupuestoListPageDTO listar(Long id, String q, Instant desde, Instant hasta,
                                         int page, int size) {
        String qNormalizada = (q == null || q.isBlank()) ? null : q.trim();
        org.springframework.data.domain.PageRequest pr =
                org.springframework.data.domain.PageRequest.of(page, size,
                        org.springframework.data.domain.Sort.by(
                                org.springframework.data.domain.Sort.Direction.DESC, "creadoAt"));
        org.springframework.data.domain.Page<PresupuestoComercial> p =
                repository.buscar(id, qNormalizada, desde, hasta, pr);
        List<PresupuestoListItemDTO> items = p.getContent().stream()
                .map(this::toListItemDTO)
                .toList();
        return new PresupuestoListPageDTO(items, p.getTotalElements(), p.getNumber(), p.getSize());
    }

    /**
     * Regenera el PDF de un presupuesto persistido. No vuelve a calcular
     * nada — se rehidratan los items y formas de pago desde los JSON
     * guardados al momento de la creación. Así el PDF queda idéntico al
     * que vio el cliente originalmente, aunque las formas de pago o
     * precios actuales hayan cambiado en el sistema.
     */
    public Resultado regenerarPdf(Long id) {
        PresupuestoComercial p = obtener(id);
        GenerarPresupuestoRequestDTO datos = rehidratarDatos(p);
        byte[] pdf = pdfGenerator.generar(p, datos);
        return new Resultado(p, pdf, pdfGenerator.nombreArchivo(p));
    }

    /** Reconstruye el DTO original a partir de los JSONs persistidos en
     *  el entity — útil para regenerar el PDF sin pedir el body al
     *  cliente. Si la deserialización falla (JSON corrupto, schema
     *  evolucionado), devuelve un DTO con listas vacías. */
    private GenerarPresupuestoRequestDTO rehidratarDatos(PresupuestoComercial p) {
        List<GenerarPresupuestoRequestDTO.Item> items = leerJson(
                p.getItemsJson(),
                new tools.jackson.core.type.TypeReference<List<GenerarPresupuestoRequestDTO.Item>>() {});
        List<GenerarPresupuestoRequestDTO.FormaPagoSnapshot> formas = leerJson(
                p.getFormasPagoJson(),
                new tools.jackson.core.type.TypeReference<List<GenerarPresupuestoRequestDTO.FormaPagoSnapshot>>() {});
        return new GenerarPresupuestoRequestDTO(
                p.getClienteNombre(),
                p.getClienteTelefono(),
                p.getClienteEmail(),
                p.getObservaciones(),
                p.getDescuentoGlobalPorcentaje(),
                items == null ? List.of() : items,
                formas == null ? List.of() : formas);
    }

    private <T> T leerJson(String json, tools.jackson.core.type.TypeReference<T> typeRef) {
        if (json == null || json.isBlank()) return null;
        try {
            return mapper.readValue(json, typeRef);
        } catch (Exception e) {
            log.warn("No se pudo deserializar JSON del presupuesto: {}", e.getMessage());
            return null;
        }
    }

    private PresupuestoListItemDTO toListItemDTO(PresupuestoComercial p) {
        return new PresupuestoListItemDTO(
                p.getId(),
                p.getCreadoAt(),
                p.getClienteNombre(),
                p.getClienteTelefono(),
                p.getClienteEmail(),
                p.getSubtotalSinIva(),
                p.getDescuentoGlobalPorcentaje());
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

    /**
     * Public + invocado vía {@link #self} para que el proxy de Spring intercepte
     * y corra realmente en background. Si dejamos package-private + llamada
     * interna {@code this.enviarPorEmailAsync}, el aspect de @Async no se aplica
     * y el envío bloquea la respuesta del controller (PDF de varios MB por SMTP
     * tarda decenas de segundos).
     */
    @Async
    public void enviarPorEmailAsync(String destinatario, Long presupuestoId,
                                    String nombreCliente, byte[] pdf, String filename) {
        try {
            MimeMessage mime = mailSender.createMimeMessage();
            MimeMessageHelper helper = new MimeMessageHelper(mime, true, "UTF-8");

            String from = StringUtils.hasText(emailFrom) ? emailFrom : mailUsername;
            if (StringUtils.hasText(from)) helper.setFrom(from);
            helper.setTo(destinatario.split("\\s*,\\s*"));
            helper.setSubject(SUBJECT + presupuestoId);

            String nombre = StringUtils.hasText(nombreCliente) ? nombreCliente : "Cliente";
            helper.setText(plainBody(nombre, presupuestoId),
                    htmlBody(escapeHtml(nombre), presupuestoId));
            helper.addAttachment(filename, new ByteArrayResource(pdf));

            log.info("Email presupuesto #{} → {} ({} KB)",
                    presupuestoId, destinatario, pdf.length / 1024);
            mailSender.send(mime);
            eventService.publish(SSE_EVENT, Map.of(
                    "estado", "SENT",
                    "presupuestoId", presupuestoId,
                    "email", destinatario));
        } catch (Exception e) {
            log.error("Falló envío de email del presupuesto #{}: {}",
                    presupuestoId, e.getMessage(), e);
            String detalle = UserMessages.traducir(e,
                    "No se pudo enviar el email. Revisar logs del backend.");
            eventService.publish(SSE_EVENT, Map.of(
                    "estado", "FAILED",
                    "presupuestoId", presupuestoId,
                    "email", destinatario,
                    "error", detalle));
        }
    }

    private PresupuestoComercial construirEntidad(GenerarPresupuestoRequestDTO datos) {
        BigDecimal subtotalSinIva = BigDecimal.ZERO;
        BigDecimal subtotalConIva = BigDecimal.ZERO;

        for (GenerarPresupuestoRequestDTO.Item it : datos.items()) {
            BigDecimal cantidad = it.cantidad() == null ? BigDecimal.ZERO : it.cantidad();
            BigDecimal precio = it.precioConIva() == null ? BigDecimal.ZERO : it.precioConIva();
            BigDecimal porcIva = it.porcIva() == null ? BigDecimal.valueOf(21) : it.porcIva();
            BigDecimal desc = it.descuentoPorcentaje() == null ? BigDecimal.ZERO : it.descuentoPorcentaje();

            BigDecimal precioConDesc = precio.multiply(
                    BigDecimal.ONE.subtract(desc.movePointLeft(2)));
            BigDecimal totalLineaConIva = precioConDesc.multiply(cantidad);
            BigDecimal divisor = BigDecimal.ONE.add(porcIva.movePointLeft(2));
            BigDecimal totalLineaSinIva = totalLineaConIva.divide(divisor, 4, RoundingMode.HALF_UP);

            subtotalSinIva = subtotalSinIva.add(totalLineaSinIva);
            subtotalConIva = subtotalConIva.add(totalLineaConIva);
        }

        // Aplicamos el descuento global al subtotal — los snapshots persistidos
        // y mostrados al cliente ya tienen el descuento aplicado para que las
        // cifras se vean coherentes con lo que ve en pantalla.
        BigDecimal descGlobal = datos.descuentoGlobalPorcentaje() == null
                ? BigDecimal.ZERO
                : datos.descuentoGlobalPorcentaje();
        BigDecimal factor = BigDecimal.ONE.subtract(descGlobal.movePointLeft(2));

        BigDecimal totalSinIva = subtotalSinIva.multiply(factor)
                .setScale(2, RoundingMode.HALF_UP);
        BigDecimal totalConIva = subtotalConIva.multiply(factor)
                .setScale(2, RoundingMode.HALF_UP);
        BigDecimal ivaTotal = totalConIva.subtract(totalSinIva)
                .setScale(2, RoundingMode.HALF_UP);

        return PresupuestoComercial.builder()
                .creadoAt(Instant.now())
                .clienteNombre(blankToNull(datos.clienteNombre()))
                .clienteTelefono(blankToNull(datos.clienteTelefono()))
                .clienteEmail(blankToNull(datos.clienteEmail()))
                .observaciones(blankToNull(datos.observaciones()))
                .descuentoGlobalPorcentaje(descGlobal)
                .subtotalSinIva(totalSinIva)
                .ivaTotal(ivaTotal)
                .totalConIva(totalConIva)
                .itemsJson(escribirJson(datos.items()))
                .formasPagoJson(datos.formasPago() == null ? "[]" : escribirJson(datos.formasPago()))
                .build();
    }

    private String escribirJson(Object o) {
        try {
            return mapper.writeValueAsString(o);
        } catch (Exception e) {
            log.warn("No se pudo serializar a JSON: {}", e.getMessage());
            return "[]";
        }
    }

    private static String blankToNull(String s) {
        return s == null || s.isBlank() ? null : s.trim();
    }

    private static String plainBody(String nombre, Long id) {
        return """
                Hola %s,

                Te dejamos adjunto el presupuesto #%d que armamos en KT GASTRO.

                Cualquier consulta, estamos a disposición.

                Saludos,
                Equipo KT GASTRO
                """.formatted(nombre, id);
    }

    private static String htmlBody(String nombreEscapado, Long id) {
        return """
                <div style="font-family: Arial, Helvetica, sans-serif; color: #2d2d2d; max-width: 600px;">
                  <h2 style="color: #FF861C; margin: 0 0 16px 0; font-size: 20px;">
                    Hola %s,
                  </h2>
                  <p style="font-size: 14px; line-height: 1.6;">
                    Te dejamos adjunto el <strong>presupuesto #%d</strong> que armamos
                    para vos en KT GASTRO. Tiene el detalle de los productos elegidos y
                    las formas de pago disponibles.
                  </p>
                  <p style="font-size: 14px; line-height: 1.6;">
                    Cualquier consulta, estamos a disposición.
                  </p>
                  <p style="font-size: 14px; color: #5a5a5a; margin-top: 24px;">
                    Saludos,<br>
                    <strong style="color: #FF861C;">Equipo KT GASTRO</strong>
                  </p>
                </div>
                """.formatted(nombreEscapado, id);
    }

    private static String escapeHtml(String s) {
        if (s == null) return "";
        return s.replace("&", "&amp;")
                .replace("<", "&lt;").replace(">", "&gt;")
                .replace("\"", "&quot;");
    }

    /** Resultado de generar — incluye la entidad (persistida con ID en el flujo
     *  de envío, transitoria con id=null en el preview), el PDF en bytes y el
     *  nombre de archivo sugerido. */
    public record Resultado(PresupuestoComercial presupuesto, byte[] pdf, String nombreArchivo) {}
}
