package ar.com.leo.showroom.pickit_externo;

import ar.com.leo.showroom.auth.repository.UsuarioRepository;
import ar.com.leo.showroom.config.service.ConfiguracionService;
import ar.com.leo.showroom.events.PickitExternoEvent;
import ar.com.leo.showroom.events.SyncEventService;
import ar.com.leo.showroom.pedido.entity.PedidoShowroom;
import ar.com.leo.showroom.showroom.dto.CarritoItemDTO;
import ar.com.leo.showroom.showroom.dto.PickitConfigDTO;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.apache.poi.ss.usermodel.Cell;
import org.apache.poi.ss.usermodel.CellStyle;
import org.apache.poi.ss.usermodel.Font;
import org.apache.poi.ss.usermodel.Row;
import org.apache.poi.ss.usermodel.Sheet;
import org.apache.poi.ss.usermodel.Workbook;
import org.apache.poi.xssf.usermodel.XSSFWorkbook;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.TimeUnit;

/**
 * Invoca el programa externo {@code pickit-y-etiquetas} (jar Java desktop) en
 * modo CLI ({@code --pickit-manual}) para generar el Excel pickit a partir
 * de los items del pedido.
 *
 * <p>El backend corre en Docker; el jar también se ejecuta dentro del container
 * (es bytecode portable y el container ya tiene Java porque corre Spring Boot).
 * Los archivos del host (jar, Stock.xlsx, Combos.xlsx, carpeta de salida) se
 * exponen via volume mounts en docker-compose. Los paths configurados desde la
 * UI ({@link ConfiguracionService#getPickitConfig()}) son <b>paths del
 * container</b> ya mapeados.
 *
 * <p>Flow: genera un .xlsx temporal con SKU+CANTIDAD → invoca el jar con
 * {@code ProcessBuilder} → lee la primera línea de stdout (path del output) →
 * publica SSE {@code pickit-externo}. Si todo OK, el .xlsx final queda en
 * {@code outputDir} (visible para el operador en la carpeta del host).
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class PickitExternoService {

    /** Timeout máximo del proceso pickit. 90s alcanza largo para listas chicas
     *  (típicamente < 5s); si el proceso se cuelga, abortamos. */
    private static final long PROCESS_TIMEOUT_SECONDS = 90;

    /** Carpeta donde guardamos el .xlsx de input antes de pasárselo al CLI.
     *  Está dentro del container (tmpfs), no en el host. */
    private static final Path INPUT_TEMP_DIR = Path.of("/tmp/pickit-input");

    private final ConfiguracionService configuracionService;
    private final SyncEventService eventService;
    /** Para publicar el toast en el canal SSE del operador propietario del
     *  pedido — sin esto, todos los operadores logueados verían el "Pickit
     *  generado" cuando uno solo de ellos creó el pedido. */
    private final UsuarioRepository usuarioRepository;

    /**
     * Validación de configuración pública. Devuelve un motivo si el envío no
     * se puede hacer (deshabilitado, paths faltantes, archivos inexistentes).
     * Útil para que el controller responda 503 con un mensaje claro en lugar
     * de fallar silenciosamente.
     */
    public Optional<String> motivoNoConfigurado() {
        PickitConfigDTO cfg = configuracionService.getPickitConfig();
        if (!cfg.enabled()) {
            return Optional.of("Generación de pickit externo deshabilitada en config");
        }
        if (!StringUtils.hasText(cfg.jarPath())) return Optional.of("Falta el path del jar");
        if (!StringUtils.hasText(cfg.stockFile())) return Optional.of("Falta el path de Stock.xlsx");
        if (!StringUtils.hasText(cfg.combosFile())) return Optional.of("Falta el path de Combos.xlsx");
        if (!StringUtils.hasText(cfg.outputDir())) return Optional.of("Falta la carpeta de salida");
        if (!Files.isRegularFile(Path.of(cfg.jarPath())))
            return Optional.of("Jar no accesible desde el backend: " + cfg.jarPath());
        if (!Files.isRegularFile(Path.of(cfg.stockFile())))
            return Optional.of("Stock.xlsx no accesible: " + cfg.stockFile());
        if (!Files.isRegularFile(Path.of(cfg.combosFile())))
            return Optional.of("Combos.xlsx no accesible: " + cfg.combosFile());
        if (!Files.isDirectory(Path.of(cfg.outputDir())))
            return Optional.of("Carpeta de salida no accesible: " + cfg.outputDir());
        return Optional.empty();
    }

    /** Una línea del input al CLI del pickit: SKU + cantidad. Es lo único que el
     *  programa necesita, así que sirve igual para un pedido persistido o para
     *  el carrito en memoria (generación al abrir el diálogo). */
    public record LineaInput(String sku, int cantidad) {}

    /**
     * Genera el pickit externo a partir de un pedido persistido. Sincrónico — el
     * caller decide si lo lanza en background. Devuelve el path del archivo
     * generado (en {@code outputDir}).
     *
     * @throws PickitExternoException si la config no es válida, el proceso
     *     falla, expira o el output no se encontró.
     */
    public Path generar(PedidoShowroom pedido) throws PickitExternoException {
        List<LineaInput> lineas = pedido.getItems().stream()
                .map(it -> new LineaInput(it.getSku(), it.getCantidad() == null ? 0 : it.getCantidad()))
                .toList();
        return generarDesdeLineas(lineas, "pedido-" + pedido.getId(), "pedido " + pedido.getId());
    }

    /**
     * Genera el pickit externo a partir de los ítems del carrito (generación al
     * abrir el diálogo de pedido, antes de que exista un pedido persistido).
     * Mismo SKU+CANTIDAD que tendrá el pedido, así que produce el mismo Excel.
     */
    public Path generarDesdeCarrito(List<CarritoItemDTO> items) throws PickitExternoException {
        List<LineaInput> lineas = items.stream()
                .map(it -> new LineaInput(it.sku(), it.cantidad()))
                .toList();
        return generarDesdeLineas(lineas, "carrito", "carrito");
    }

    /**
     * Núcleo compartido: escribe el .xlsx de input con las líneas dadas, invoca
     * el CLI y devuelve el path del .xlsx generado.
     *
     * @param tempPrefix prefijo del archivo temporal de input (se le agrega un
     *                   timestamp para unicidad entre invocaciones concurrentes).
     * @param label      etiqueta para los logs (ej. "pedido 42" o "carrito").
     */
    private Path generarDesdeLineas(List<LineaInput> lineas, String tempPrefix, String label)
            throws PickitExternoException {
        Optional<String> motivo = motivoNoConfigurado();
        if (motivo.isPresent()) {
            throw new PickitExternoException(motivo.get());
        }
        PickitConfigDTO cfg = configuracionService.getPickitConfig();
        Path inputXlsx = null;
        try {
            Files.createDirectories(INPUT_TEMP_DIR);
            inputXlsx = INPUT_TEMP_DIR.resolve(tempPrefix + "-" + System.currentTimeMillis() + ".xlsx");
            escribirInputXlsx(lineas, inputXlsx);
            log.info("Pickit externo {} — input {} ({} items)", label, inputXlsx, lineas.size());
            return invocarCli(cfg, inputXlsx);
        } catch (PickitExternoException e) {
            throw e;
        } catch (Exception e) {
            log.error("Pickit externo {} falló: {}", label, e.getMessage(), e);
            throw new PickitExternoException("Error generando pickit: " + e.getMessage(), e);
        } finally {
            // Borramos el input temp aunque haya fallado — no contamina /tmp del
            // container entre invocaciones.
            if (inputXlsx != null) {
                try { Files.deleteIfExists(inputXlsx); } catch (IOException ignored) {}
            }
        }
    }

    /**
     * Async post-DUX OK: ejecuta {@link #generar(PedidoShowroom)} en background
     * y publica el resultado via SSE para que el frontend muestre un toast.
     * No tira excepción — los errores se logean y se mandan como evento FAILED.
     *
     * <p>Si la integración no está configurada, retorna silenciosamente (no
     * dispara FAILED) — mismo patrón que {@code PickingEmailService.enviarAsync}
     * cuando email está deshabilitado. El disparo manual desde la pantalla de
     * pedidos sigue chequeando vía {@link #motivoNoConfigurado()} en el
     * controller, así que ese path retorna 503 antes de llegar acá.
     *
     * @param clientId id de la pestaña/PC que originó el pedido (header
     *                 {@code X-Client-Id}). Se propaga al evento SSE para que
     *                 solo esa PC auto-descargue el archivo generado. Puede
     *                 ser null — en ese caso nadie auto-descarga.
     */
    @Async
    public void generarAsync(PedidoShowroom pedido, String clientId) {
        generarAsync(pedido, clientId, null);
    }

    /**
     * Versión con override del operador destinatario del toast SSE. {@code
     * operadorActual} es el username del que apretó el botón "regenerar
     * pickit" desde {@code POST /pedidos/{id}/pickit-externo} — puede no ser
     * el creador del pedido. Si es null, cae al creador como fallback (path
     * automático post-pedido OK).
     */
    @Async
    public void generarAsync(PedidoShowroom pedido, String clientId, String operadorActual) {
        if (motivoNoConfigurado().isPresent()) {
            log.debug("Pickit externo no configurado — pedido {} no se procesa.", pedido.getId());
            return;
        }
        // Operador efectivo: override del que apretó el botón o creador del
        // pedido como fallback. clientId sigue siendo la PC específica para
        // que el auto-descargue del .xlsx solo se dispare donde fue creado
        // el pedido (relevante si el operador tiene varias pestañas/PCs).
        String operador = operadorActual != null ? operadorActual
                : (pedido.getUsuarioId() == null ? null
                        : usuarioRepository.findById(pedido.getUsuarioId())
                                .map(u -> u.getUsername()).orElse(null));
        try {
            Path resultado = generar(pedido);
            log.info("Pickit externo pedido {} OK: {}", pedido.getId(), resultado);
            publicarEvento(operador,
                    PickitExternoEvent.generated(pedido.getId(), resultado.toString(), clientId));
        } catch (PickitExternoException e) {
            log.warn("Pickit externo pedido {} falló: {}", pedido.getId(), e.getMessage());
            publicarEvento(operador,
                    PickitExternoEvent.failed(pedido.getId(), e.getMessage(), clientId));
        }
    }

    /**
     * Async desde el carrito: genera el pickit al ABRIR el diálogo de pedido (el
     * pedido todavía no existe) para que esté listo mientras el operador carga
     * los datos del cliente. Publica el resultado via SSE con {@code pedidoId}
     * null — el toast lo identifica como "del carrito" y la PC origen
     * (matcheada por {@code clientId}) auto-descarga el .xlsx.
     *
     * <p>Si la integración no está configurada retorna silenciosamente, mismo
     * patrón que {@link #generarAsync(PedidoShowroom, String, String)}.
     *
     * @param items     copia inmutable de los ítems del carrito (el caller pasa
     *                  {@code carritoService.obtener(...).items()}, ya inmutable).
     * @param operador  username destinatario del toast SSE.
     * @param clientId  PC/pestaña origen (header {@code X-Client-Id}) para el
     *                  auto-descargue; null = nadie auto-descarga.
     */
    @Async
    public void generarDesdeCarritoAsync(List<CarritoItemDTO> items, String operador, String clientId) {
        if (motivoNoConfigurado().isPresent()) {
            log.debug("Pickit externo no configurado — carrito de {} no se procesa.", operador);
            return;
        }
        try {
            Path resultado = generarDesdeCarrito(items);
            log.info("Pickit externo carrito de {} OK: {}", operador, resultado);
            publicarEvento(operador, PickitExternoEvent.generated(null, resultado.toString(), clientId));
        } catch (PickitExternoException e) {
            log.warn("Pickit externo carrito de {} falló: {}", operador, e.getMessage());
            publicarEvento(operador, PickitExternoEvent.failed(null, e.getMessage(), clientId));
        }
    }

    /** Publica al canal del operador o broadcast global como fallback. */
    private void publicarEvento(String operador, Object payload) {
        if (operador != null) {
            eventService.publishTo(operador, "pickit-externo", payload);
        } else {
            eventService.publish("pickit-externo", payload);
        }
    }

    /**
     * Escribe el .xlsx que el CLI del pickit espera: hoja única con headers
     * {@code SKU} y {@code CANTIDAD} (uppercase — así los busca el parser
     * {@code ExcelManager.obtenerProductosManualesDesdeExcel}). El SKU debe
     * ser numérico (regex {@code \d+}) sino el parser lo descarta.
     */
    void escribirInputXlsx(List<LineaInput> lineas, Path destino) throws IOException {
        try (Workbook wb = new XSSFWorkbook()) {
            Sheet sheet = wb.createSheet("Picking");
            CellStyle headerStyle = wb.createCellStyle();
            Font bold = wb.createFont();
            bold.setBold(true);
            headerStyle.setFont(bold);

            Row header = sheet.createRow(0);
            Cell h1 = header.createCell(0); h1.setCellValue("SKU"); h1.setCellStyle(headerStyle);
            Cell h2 = header.createCell(1); h2.setCellValue("CANTIDAD"); h2.setCellStyle(headerStyle);

            int rowIdx = 1;
            for (LineaInput it : lineas) {
                Row row = sheet.createRow(rowIdx++);
                row.createCell(0).setCellValue(it.sku() == null ? "" : it.sku());
                row.createCell(1).setCellValue(it.cantidad());
            }
            sheet.setColumnWidth(0, 6000);
            sheet.setColumnWidth(1, 4000);
            try (var out = Files.newOutputStream(destino)) {
                wb.write(out);
            }
        }
    }

    /**
     * Ejecuta {@code java -jar pickit-y-etiquetas.jar --pickit-manual ...} y
     * captura stdout. El CLI imprime al stdout una sola línea con el path del
     * .xlsx generado, y sale con código 0. Cualquier otro código → error.
     */
    private Path invocarCli(PickitConfigDTO cfg, Path inputXlsx) throws PickitExternoException, IOException, InterruptedException {
        ProcessBuilder pb = new ProcessBuilder(
                "java", "-jar", cfg.jarPath(),
                "--pickit-manual",
                "--input", inputXlsx.toString(),
                "--stock", cfg.stockFile(),
                "--combos", cfg.combosFile(),
                "--output-dir", cfg.outputDir());
        pb.redirectErrorStream(false);
        Process proc = pb.start();
        StringBuilder stdout = new StringBuilder();
        StringBuilder stderr = new StringBuilder();
        Thread stdoutPump = new Thread(() -> drenar(proc.getInputStream(), stdout));
        Thread stderrPump = new Thread(() -> drenar(proc.getErrorStream(), stderr));
        stdoutPump.start();
        stderrPump.start();
        boolean termino = proc.waitFor(PROCESS_TIMEOUT_SECONDS, TimeUnit.SECONDS);
        if (!termino) {
            proc.destroyForcibly();
            throw new PickitExternoException("El proceso pickit no terminó en " + PROCESS_TIMEOUT_SECONDS + "s");
        }
        stdoutPump.join(2000);
        stderrPump.join(2000);
        int exitCode = proc.exitValue();
        if (exitCode != 0) {
            String err = stderr.toString().trim();
            throw new PickitExternoException("pickit-y-etiquetas exit " + exitCode
                    + (err.isEmpty() ? "" : ": " + err));
        }
        // El CLI imprime el path en la última línea del stdout (los pasos de
        // log van interleaved). Tomamos la última línea no vacía como el path.
        String[] lineas = stdout.toString().split("\\R");
        String pathOutput = "";
        for (int i = lineas.length - 1; i >= 0; i--) {
            String l = lineas[i].trim();
            if (!l.isEmpty()) { pathOutput = l; break; }
        }
        if (pathOutput.isEmpty()) {
            throw new PickitExternoException("El CLI no devolvió el path del output. stderr: " + stderr);
        }
        Path resultado = Path.of(pathOutput);
        if (!Files.exists(resultado)) {
            throw new PickitExternoException("El CLI dijo que generó " + pathOutput
                    + " pero el archivo no existe");
        }
        return renombrarConPrefijoShowroom(resultado);
    }

    /**
     * Renombra el .xlsx generado por el CLI para anteponerle {@code SHOWROOM-}
     * (si todavía no lo tiene). Así la operadora identifica rápido los archivos
     * que vienen del showroom dentro del outputDir compartido.
     *
     * <p>Si el destino ya existe, se sobreescribe (REPLACE_EXISTING). Si el
     * rename falla, logueamos y devolvemos el path original — no rompemos la
     * generación por un detalle cosmético.
     */
    private Path renombrarConPrefijoShowroom(Path original) {
        String nombre = original.getFileName().toString();
        if (nombre.toUpperCase(java.util.Locale.ROOT).startsWith("SHOWROOM")) {
            return original;
        }
        Path destino = original.resolveSibling("SHOWROOM-" + nombre);
        try {
            return Files.move(original, destino, StandardCopyOption.REPLACE_EXISTING);
        } catch (IOException e) {
            log.warn("No se pudo renombrar {} → {}: {}", original, destino, e.getMessage());
            return original;
        }
    }

    private static void drenar(InputStream is, StringBuilder dest) {
        try (var reader = new BufferedReader(new InputStreamReader(is))) {
            String line;
            while ((line = reader.readLine()) != null) {
                dest.append(line).append('\n');
            }
        } catch (IOException ignored) {
            // Stream cerrado por el proceso, ignoramos.
        }
    }

    /** Excepción dedicada para errores específicos del pickit externo. */
    public static class PickitExternoException extends Exception {
        public PickitExternoException(String message) { super(message); }
        public PickitExternoException(String message, Throwable cause) { super(message, cause); }
    }
}
