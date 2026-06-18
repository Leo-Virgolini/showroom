package ar.com.leo.showroom.pickit_externo;

import ar.com.leo.showroom.pickit_externo.PickitExternoService.LineaInput;
import org.apache.poi.ss.usermodel.Row;
import org.apache.poi.ss.usermodel.Sheet;
import org.apache.poi.ss.usermodel.Workbook;
import org.apache.poi.xssf.usermodel.XSSFWorkbook;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * El CLI {@code pickit-y-etiquetas} parsea el .xlsx de input buscando los
 * headers {@code SKU}/{@code CANTIDAD} (uppercase) y una fila por ítem. Este
 * test fija ese contrato: si cambia el formato, el programa externo deja de
 * leer las listas del showroom.
 */
class PickitExternoInputXlsxTest {

    // escribirInputXlsx no toca las dependencias inyectadas, así que las pasamos null.
    private final PickitExternoService service = new PickitExternoService(null, null, null);

    @Test
    void escribe_headers_y_una_fila_por_linea(@TempDir Path tmp) throws IOException {
        Path destino = tmp.resolve("input.xlsx");
        service.escribirInputXlsx(
                List.of(new LineaInput("12345", 3), new LineaInput("67890", 1)),
                destino);

        try (Workbook wb = new XSSFWorkbook(Files.newInputStream(destino))) {
            Sheet sheet = wb.getSheetAt(0);

            Row header = sheet.getRow(0);
            assertThat(header.getCell(0).getStringCellValue()).isEqualTo("SKU");
            assertThat(header.getCell(1).getStringCellValue()).isEqualTo("CANTIDAD");

            Row fila1 = sheet.getRow(1);
            assertThat(fila1.getCell(0).getStringCellValue()).isEqualTo("12345");
            assertThat(fila1.getCell(1).getNumericCellValue()).isEqualTo(3);

            Row fila2 = sheet.getRow(2);
            assertThat(fila2.getCell(0).getStringCellValue()).isEqualTo("67890");
            assertThat(fila2.getCell(1).getNumericCellValue()).isEqualTo(1);

            // No hay filas de más después de los ítems.
            assertThat(sheet.getLastRowNum()).isEqualTo(2);
        }
    }
}
