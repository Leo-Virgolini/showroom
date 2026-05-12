package ar.com.leo.showroom.pickit_externo;

import ar.com.leo.showroom.config.service.ConfiguracionService;
import ar.com.leo.showroom.events.PickitExternoEvent;
import ar.com.leo.showroom.events.SyncEventService;
import ar.com.leo.showroom.pedido.entity.PedidoShowroom;
import ar.com.leo.showroom.pedido.entity.PedidoShowroomItem;
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

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
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

    /**
     * Genera el pickit externo. Sincrónico — el caller decide si lo lanza en
     * background. Devuelve el path del archivo generado (en {@code outputDir}).
     *
     * @throws PickitExternoException si la config no es válida, el proceso
     *     falla, expira o el output no se encontró.
     */
    public Path generar(PedidoShowroom pedido) throws PickitExternoException {
        Optional<String> motivo = motivoNoConfigurado();
        if (motivo.isPresent()) {
            throw new PickitExternoException(motivo.get());
        }
        PickitConfigDTO cfg = configuracionService.getPickitConfig();
        Path inputXlsx = null;
        try {
            Files.createDirectories(INPUT_TEMP_DIR);
            inputXlsx = INPUT_TEMP_DIR.resolve("pedido-" + pedido.getId() + "-" + System.currentTimeMillis() + ".xlsx");
            escribirInputXlsx(pedido, inputXlsx);
            log.info("Pickit externo pedido {} — input {} ({} items)",
                    pedido.getId(), inputXlsx, pedido.getItems().size());
            return invocarCli(cfg, inputXlsx);
        } catch (PickitExternoException e) {
            throw e;
        } catch (Exception e) {
            log.error("Pickit externo pedido {} falló: {}", pedido.getId(), e.getMessage(), e);
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
     */
    @Async
    public void generarAsync(PedidoShowroom pedido) {
        try {
            Path resultado = generar(pedido);
            log.info("Pickit externo pedido {} OK: {}", pedido.getId(), resultado);
            eventService.publish("pickit-externo",
                    PickitExternoEvent.generated(pedido.getId(), resultado.toString()));
        } catch (PickitExternoException e) {
            log.warn("Pickit externo pedido {} falló: {}", pedido.getId(), e.getMessage());
            eventService.publish("pickit-externo",
                    PickitExternoEvent.failed(pedido.getId(), e.getMessage()));
        }
    }

    /**
     * Escribe el .xlsx que el CLI del pickit espera: hoja única con headers
     * {@code SKU} y {@code CANTIDAD} (uppercase — así los busca el parser
     * {@code ExcelManager.obtenerProductosManualesDesdeExcel}). El SKU debe
     * ser numérico (regex {@code \d+}) sino el parser lo descarta.
     */
    private void escribirInputXlsx(PedidoShowroom pedido, Path destino) throws IOException {
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
            for (PedidoShowroomItem it : pedido.getItems()) {
                Row row = sheet.createRow(rowIdx++);
                row.createCell(0).setCellValue(it.getSku() == null ? "" : it.getSku());
                row.createCell(1).setCellValue(it.getCantidad() == null ? 0 : it.getCantidad());
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
        return resultado;
    }

    private static void drenar(java.io.InputStream is, StringBuilder dest) {
        try (var reader = new java.io.BufferedReader(new java.io.InputStreamReader(is))) {
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
