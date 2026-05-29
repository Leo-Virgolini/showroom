package ar.com.leo.showroom.cotizacion.service;

import ar.com.leo.showroom.auth.repository.UsuarioRepository;
import ar.com.leo.showroom.common.exception.NotFoundException;
import ar.com.leo.showroom.common.exception.UserMessages;
import ar.com.leo.showroom.cotizacion.dto.CotizacionDetalleDTO;
import ar.com.leo.showroom.cotizacion.dto.CotizacionListItemDTO;
import ar.com.leo.showroom.cotizacion.dto.CotizacionListPageDTO;
import ar.com.leo.showroom.cotizacion.dto.GenerarCotizacionRequestDTO;
import ar.com.leo.showroom.cotizacion.entity.CotizacionFinanciera;
import ar.com.leo.showroom.cotizacion.repository.CotizacionFinancieraRepository;
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
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.StringUtils;
import tools.jackson.databind.ObjectMapper;

import java.math.BigDecimal;
import java.net.SocketTimeoutException;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * Orquesta el ciclo de vida de la cotización financiera: persiste, genera el
 * PDF y dispara el envío del email. Mismo patrón que
 * {@code PresupuestoComercialService} pero mucho más simple — sin items
 * (solo un monto base), sin descuentos por línea, una sola hoja de PDF.
 */
@Slf4j
@Service
public class CotizacionFinancieraService {

    private static final String SSE_EVENT = "cotizacion-financiera-email";
    private static final String SUBJECT = "KT GASTRO — Cotización financiera #";

    private final CotizacionFinancieraRepository repository;
    private final CotizacionFinancieraPdfGenerator pdfGenerator;
    private final JavaMailSender mailSender;
    private final SyncEventService eventService;
    private final ObjectMapper mapper;
    private final UsuarioRepository usuarioRepository;

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
            CotizacionFinancieraRepository repository,
            CotizacionFinancieraPdfGenerator pdfGenerator,
            ObjectProvider<JavaMailSender> mailSender,
            SyncEventService eventService,
            ObjectMapper mapper,
            UsuarioRepository usuarioRepository) {
        this.repository = repository;
        this.pdfGenerator = pdfGenerator;
        this.mailSender = mailSender.getIfAvailable();
        this.eventService = eventService;
        this.mapper = mapper;
        this.usuarioRepository = usuarioRepository;
    }

    private Long usuarioIdDe(String username) {
        if (username == null) return null;
        return usuarioRepository.findByUsername(username).map(u -> u.getId()).orElse(null);
    }

    private void publicarEvento(String operador, Object payload) {
        if (operador != null) {
            eventService.publishTo(operador, SSE_EVENT, payload);
        } else {
            eventService.publish(SSE_EVENT, payload);
        }
    }

    @Transactional
    public Resultado generarYPersistir(GenerarCotizacionRequestDTO datos, String username) {
        CotizacionFinanciera c = construirEntidad(datos);
        c.setUsuarioId(usuarioIdDe(username));
        c = repository.save(c);
        byte[] pdf = pdfGenerator.generar(c, datos);
        return new Resultado(c, pdf, pdfGenerator.nombreArchivo(c));
    }

    @Transactional
    public Resultado generarYEnviarPorEmail(String destinatario,
                                            GenerarCotizacionRequestDTO datos,
                                            String username) {
        Resultado r = generarYPersistir(datos, username);
        self.enviarPorEmailAsync(destinatario, r.cotizacion().getId(),
                r.cotizacion().getClienteNombre(), r.pdf(), r.nombreArchivo(),
                username);
        return r;
    }

    @Transactional
    public Resultado actualizar(Long id, GenerarCotizacionRequestDTO datos, String username) {
        CotizacionFinanciera c = obtener(id);
        aplicarDatos(c, datos);
        c.setModificadoAt(Instant.now());
        c = repository.save(c);
        byte[] pdf = pdfGenerator.generar(c, datos);
        return new Resultado(c, pdf, pdfGenerator.nombreArchivo(c));
    }

    @Transactional
    public Resultado actualizarYEnviarPorEmail(Long id, String destinatario,
                                               GenerarCotizacionRequestDTO datos,
                                               String username) {
        Resultado r = actualizar(id, datos, username);
        self.enviarPorEmailAsync(destinatario, r.cotizacion().getId(),
                r.cotizacion().getClienteNombre(), r.pdf(), r.nombreArchivo(),
                username);
        return r;
    }

    public CotizacionDetalleDTO obtenerDetalle(Long id) {
        CotizacionFinanciera c = obtener(id);
        List<GenerarCotizacionRequestDTO.FormaPagoSnapshot> formas = leerFormas(c.getFormasPagoJson());
        return new CotizacionDetalleDTO(
                c.getId(),
                c.getCreadoAt(),
                c.getModificadoAt(),
                c.getClienteNombre(),
                c.getClienteTelefono(),
                c.getClienteEmail(),
                c.getRubro(),
                c.getObservaciones(),
                c.getMontoBaseSinIva(),
                c.getPorcIva(),
                c.getMontoBaseSinIva2(),
                c.getPorcIva2(),
                formas);
    }

    public CotizacionFinanciera obtener(Long id) {
        CotizacionFinanciera c = repository.findById(id)
                .orElseThrow(() -> new NotFoundException("Cotización no encontrada: " + id));
        if (c.getEliminadoAt() != null) {
            throw new NotFoundException("Cotización eliminada: " + id);
        }
        return c;
    }

    @Transactional
    public void eliminar(Long id) {
        CotizacionFinanciera c = repository.findById(id)
                .orElseThrow(() -> new NotFoundException("Cotización no encontrada: " + id));
        if (c.getEliminadoAt() != null) return;
        c.setEliminadoAt(Instant.now());
        repository.save(c);
    }

    public CotizacionListPageDTO listar(Long id, String q, Instant desde, Instant hasta,
                                        int page, int size) {
        String qNormalizada = (q == null || q.isBlank()) ? null : q.trim();
        org.springframework.data.domain.PageRequest pr =
                org.springframework.data.domain.PageRequest.of(page, size,
                        org.springframework.data.domain.Sort.by(
                                org.springframework.data.domain.Sort.Direction.DESC, "creadoAt"));
        org.springframework.data.domain.Page<CotizacionFinanciera> p =
                repository.buscar(id, qNormalizada, desde, hasta, pr);
        java.util.Set<Long> usuarioIds = p.getContent().stream()
                .map(CotizacionFinanciera::getUsuarioId)
                .filter(java.util.Objects::nonNull)
                .collect(java.util.stream.Collectors.toSet());
        Map<Long, String> operadores = usuarioIds.isEmpty() ? Map.of()
                : usuarioRepository.findAllById(usuarioIds).stream()
                        .collect(java.util.stream.Collectors.toMap(
                                u -> u.getId(),
                                u -> (u.getNombre() != null && !u.getNombre().isBlank())
                                        ? u.getNombre().trim() : u.getUsername()));
        List<CotizacionListItemDTO> items = p.getContent().stream()
                .map(c -> toListItemDTO(c,
                        c.getUsuarioId() == null ? null : operadores.get(c.getUsuarioId())))
                .toList();
        return new CotizacionListPageDTO(items, p.getTotalElements(), p.getNumber(), p.getSize());
    }

    /**
     * Regenera el PDF de una cotización persistida — útil para que el
     * operador descargue el mismo PDF desde el historial sin tener que
     * editar/regenerar el contenido.
     */
    public Resultado regenerarPdf(Long id) {
        CotizacionFinanciera c = obtener(id);
        GenerarCotizacionRequestDTO datos = rehidratarDatos(c);
        byte[] pdf = pdfGenerator.generar(c, datos);
        return new Resultado(c, pdf, pdfGenerator.nombreArchivo(c));
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
    public void enviarPorEmailAsync(String destinatario, Long cotizacionId,
                                    String nombreCliente, byte[] pdf, String filename,
                                    String operador) {
        try {
            MimeMessage mime = mailSender.createMimeMessage();
            MimeMessageHelper helper = new MimeMessageHelper(mime, true, "UTF-8");

            String from = StringUtils.hasText(emailFrom) ? emailFrom : mailUsername;
            if (StringUtils.hasText(from)) helper.setFrom(from);
            helper.setTo(destinatario.split("\\s*,\\s*"));
            helper.setSubject(SUBJECT + cotizacionId);

            String nombre = StringUtils.hasText(nombreCliente) ? nombreCliente : "Cliente";
            helper.setText(plainBody(nombre, cotizacionId),
                    htmlBody(escapeHtml(nombre), cotizacionId));
            helper.addAttachment(filename, new ByteArrayResource(pdf));

            log.info("Email cotización #{} → {} ({} KB)",
                    cotizacionId, destinatario, pdf.length / 1024);
            mailSender.send(mime);
            publicarEvento(operador, Map.of(
                    "estado", "SENT",
                    "cotizacionId", cotizacionId,
                    "email", destinatario));
        } catch (Exception e) {
            if (esReadTimeoutPostUpload(e)) {
                log.warn("Email cotización #{} — Read timed out esperando ACK de Gmail "
                        + "(PDF={}KB). El mail probablemente se entregó: {}",
                        cotizacionId, pdf.length / 1024, e.getMessage());
                publicarEvento(operador, Map.of(
                        "estado", "AMBIGUO",
                        "cotizacionId", cotizacionId,
                        "email", destinatario,
                        "error", "Gmail tardó en confirmar. El mail probablemente llegó."));
                return;
            }
            log.error("Falló envío de email de la cotización #{}: {}",
                    cotizacionId, e.getMessage(), e);
            String detalle = UserMessages.traducir(e,
                    "No se pudo enviar el email. Revisar logs del backend.");
            publicarEvento(operador, Map.of(
                    "estado", "FAILED",
                    "cotizacionId", cotizacionId,
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

    private CotizacionFinanciera construirEntidad(GenerarCotizacionRequestDTO datos) {
        CotizacionFinanciera c = new CotizacionFinanciera();
        c.setCreadoAt(Instant.now());
        aplicarDatos(c, datos);
        return c;
    }

    /** Pisa los campos editables del DTO sobre la entity. NO toca id,
     *  creadoAt, modificadoAt, usuarioId, eliminadoAt.
     *
     *  <p>Valida que al menos uno de los dos montos sea > 0 — si los dos
     *  vienen null/cero, lanza IllegalArgumentException (el @Positive del
     *  DTO no aplica acá porque ambos son @PositiveOrZero independientes). */
    private void aplicarDatos(CotizacionFinanciera c, GenerarCotizacionRequestDTO datos) {
        BigDecimal monto1 = datos.montoBaseSinIva();
        BigDecimal monto2 = datos.montoBaseSinIva2();
        boolean tieneMonto1 = monto1 != null && monto1.signum() > 0;
        boolean tieneMonto2 = monto2 != null && monto2.signum() > 0;
        if (!tieneMonto1 && !tieneMonto2) {
            throw new IllegalArgumentException(
                    "Tenés que ingresar al menos uno de los dos montos para cotizar");
        }
        c.setClienteNombre(blankToNull(datos.clienteNombre()));
        c.setClienteTelefono(blankToNull(datos.clienteTelefono()));
        c.setClienteEmail(blankToNull(datos.clienteEmail()));
        c.setRubro(blankToNull(datos.rubro()));
        c.setObservaciones(blankToNull(datos.observaciones()));
        c.setMontoBaseSinIva(tieneMonto1 ? monto1 : BigDecimal.ZERO);
        c.setPorcIva(datos.porcIva() == null ? BigDecimal.valueOf(21) : datos.porcIva());
        c.setMontoBaseSinIva2(tieneMonto2 ? monto2 : null);
        c.setPorcIva2(tieneMonto2
                ? (datos.porcIva2() == null ? new BigDecimal("10.5") : datos.porcIva2())
                : null);
        c.setFormasPagoJson(escribirJson(datos.formasPago()));
    }

    /** Reconstruye el DTO original a partir del JSON persistido — usado
     *  para regenerar PDF sin re-recibir el body. */
    private GenerarCotizacionRequestDTO rehidratarDatos(CotizacionFinanciera c) {
        List<GenerarCotizacionRequestDTO.FormaPagoSnapshot> formas = leerFormas(c.getFormasPagoJson());
        return new GenerarCotizacionRequestDTO(
                c.getClienteNombre(),
                c.getClienteTelefono(),
                c.getClienteEmail(),
                c.getRubro(),
                c.getObservaciones(),
                c.getMontoBaseSinIva(),
                c.getPorcIva(),
                c.getMontoBaseSinIva2(),
                c.getPorcIva2(),
                formas == null ? List.of() : formas);
    }

    private List<GenerarCotizacionRequestDTO.FormaPagoSnapshot> leerFormas(String json) {
        if (json == null || json.isBlank()) return List.of();
        try {
            return mapper.readValue(json,
                    new tools.jackson.core.type.TypeReference<List<GenerarCotizacionRequestDTO.FormaPagoSnapshot>>() {});
        } catch (Exception e) {
            log.warn("No se pudo deserializar formas_pago_json de cotización: {}", e.getMessage());
            return List.of();
        }
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

    private CotizacionListItemDTO toListItemDTO(CotizacionFinanciera c, String creadoPor) {
        // Para el listado mostramos la suma de los dos montos — si la
        // cotización usa solo uno, el otro suma cero. Así el operador ve
        // el "tamaño" real de la cotización aunque haya partido el monto
        // por tasas de IVA distintas.
        BigDecimal m1 = c.getMontoBaseSinIva() == null ? BigDecimal.ZERO : c.getMontoBaseSinIva();
        BigDecimal m2 = c.getMontoBaseSinIva2() == null ? BigDecimal.ZERO : c.getMontoBaseSinIva2();
        return new CotizacionListItemDTO(
                c.getId(),
                c.getCreadoAt(),
                c.getModificadoAt(),
                c.getClienteNombre(),
                c.getClienteTelefono(),
                c.getClienteEmail(),
                c.getRubro(),
                m1.add(m2),
                creadoPor);
    }

    private static String plainBody(String nombre, Long id) {
        return """
                Hola %s,

                Te dejamos adjunta la cotización financiera #%d que armamos en KT GASTRO.

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
                    Te dejamos adjunta la <strong>cotización financiera #%d</strong> que
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
                """.formatted(nombreEscapado, id);
    }

    private static String escapeHtml(String s) {
        if (s == null) return "";
        return s.replace("&", "&amp;")
                .replace("<", "&lt;").replace(">", "&gt;")
                .replace("\"", "&quot;");
    }

    /** Resultado del generar/actualizar — entidad + PDF + filename. */
    public record Resultado(CotizacionFinanciera cotizacion, byte[] pdf, String nombreArchivo) {}
}
