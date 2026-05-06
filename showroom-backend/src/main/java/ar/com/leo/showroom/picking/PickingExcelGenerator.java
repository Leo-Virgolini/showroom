package ar.com.leo.showroom.picking;

import ar.com.leo.showroom.pedido.entity.PedidoShowroom;
import ar.com.leo.showroom.pedido.entity.PedidoShowroomItem;
import lombok.extern.slf4j.Slf4j;
import org.apache.poi.ss.usermodel.*;
import org.apache.poi.xssf.usermodel.XSSFWorkbook;
import org.springframework.stereotype.Component;

import java.io.ByteArrayOutputStream;

/**
 * Genera el XLSX de picking para un pedido: dos columnas (SKU, Cantidad), una fila por item.
 * Es el input del sistema externo de picking (lo procesa la operadora).
 */
@Slf4j
@Component
public class PickingExcelGenerator {

    public byte[] generar(PedidoShowroom pedido) {
        try (Workbook wb = new XSSFWorkbook(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            Sheet sheet = wb.createSheet("Picking");

            CellStyle headerStyle = wb.createCellStyle();
            Font headerFont = wb.createFont();
            headerFont.setBold(true);
            headerStyle.setFont(headerFont);

            Row header = sheet.createRow(0);
            Cell h1 = header.createCell(0);
            h1.setCellValue("SKU");
            h1.setCellStyle(headerStyle);
            Cell h2 = header.createCell(1);
            h2.setCellValue("Cantidad");
            h2.setCellStyle(headerStyle);

            int rowIdx = 1;
            for (PedidoShowroomItem it : pedido.getItems()) {
                Row row = sheet.createRow(rowIdx++);
                row.createCell(0).setCellValue(it.getSku() == null ? "" : it.getSku());
                row.createCell(1).setCellValue(it.getCantidad() == null ? 0 : it.getCantidad());
            }

            sheet.setColumnWidth(0, 6000);
            sheet.setColumnWidth(1, 4000);

            wb.write(out);
            return out.toByteArray();
        } catch (Exception e) {
            log.error("Error generando XLSX de picking para pedido {}: {}", pedido.getId(), e.getMessage(), e);
            throw new RuntimeException("Error generando picking XLSX", e);
        }
    }

    /** Nombre del archivo: picking-{cliente}-pedido-{id}-{ddMMyyyy}.xlsx */
    public String nombreArchivo(PedidoShowroom pedido) {
        // TZ AR explícita: el nombre del archivo refleja el día calendario del
        // showroom, no de la JVM (que en cloud puede estar en UTC).
        java.time.ZoneId tzAr = java.time.ZoneId.of("America/Argentina/Buenos_Aires");
        java.time.LocalDate fecha = pedido.getCreadoAt() != null
                ? pedido.getCreadoAt().atZone(tzAr).toLocalDate()
                : java.time.LocalDate.now(tzAr);
        String fechaStr = fecha.format(java.time.format.DateTimeFormatter.ofPattern("ddMMyyyy"));
        String cliente = NombreArchivoUtils.sanitizar(pedido.getNombreCompleto());
        return "picking-" + cliente + "-pedido-" + pedido.getId() + "-" + fechaStr + ".xlsx";
    }
}
