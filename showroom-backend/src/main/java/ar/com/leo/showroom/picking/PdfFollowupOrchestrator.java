package ar.com.leo.showroom.picking;

import ar.com.leo.showroom.config.service.ConfiguracionService;
import ar.com.leo.showroom.pedido.entity.PedidoShowroom;
import ar.com.leo.showroom.pedido.entity.PedidoShowroomItem;
import ar.com.leo.showroom.sesion.entity.SesionShowroom;
import ar.com.leo.showroom.sesion.repository.SesionShowroomRepository;
import ar.com.leo.showroom.showroom.dto.NotificacionesAutoConfigDTO;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;

import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * Orquesta el envío automático del PDF de follow-up tras un pedido OK con
 * estrategia de fallback: <b>WhatsApp primero, email si WhatsApp no llegó</b>.
 *
 * <p>Reglas:
 * <ul>
 *   <li>Si el pedido tiene teléfono → intentar WhatsApp.
 *       <ul>
 *         <li>Si llegó (Meta acepta dentro de la ventana 24hs) → done.</li>
 *         <li>Si NO llegó (ventana cerrada, sin sesión, error de Meta, etc.)
 *             → intentar email si el pedido tiene email cargado.</li>
 *       </ul>
 *   </li>
 *   <li>Si el pedido NO tiene teléfono → intentar email directo si hay email.</li>
 *   <li>Si no hay ni teléfono ni email → no se manda nada (skip silencioso).</li>
 * </ul>
 *
 * <p>Cada intento emite su propio SSE ({@code whatsapp-business} o
 * {@code picking-email}) con el outcome real, así el operador ve toasts
 * informativos del/los intento(s) — útil para entender por qué WhatsApp
 * no llegó cuando se aplica el fallback.
 *
 * <p>El método es {@code @Async}: la transacción del controller commitea
 * antes y este orquestador corre en thread separado del pool de Spring.
 *
 * <p><b>Importante:</b> los disparos manuales desde /pedidos NO usan este
 * orquestador — el operador eligió un canal específico y la app respeta
 * esa decisión sin fallback automático.
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class PdfFollowupOrchestrator {

    private final WhatsappBusinessService whatsappService;
    private final PickingEmailService emailService;
    private final ConfiguracionService configuracionService;
    private final SesionShowroomRepository sesionRepository;

    @Async
    public void enviarTrasPedido(PedidoShowroom pedido) {
        boolean tieneTelefono = StringUtils.hasText(pedido.getTelefono());
        boolean tieneEmail = StringUtils.hasText(pedido.getEmail());

        if (!tieneTelefono && !tieneEmail) {
            log.info("Pedido {} sin email ni teléfono — no hay canal para mandar el PDF.",
                    pedido.getId());
            return;
        }

        // Pre-check: si el cliente compró TODO lo que vio, no hay PDF de
        // follow-up que mandar. Saltamos sin intentar ningún canal — evita
        // disparar dos toasts SKIPPED (uno por WhatsApp, otro por email).
        // Los disparos manuales desde /pedidos NO pasan por acá: ahí cada
        // service emite SKIPPED directamente para informar al operador.
        if (!hayItemsExtraQueMandar(pedido)) {
            log.info("Pedido {} — el cliente compró todo lo que vio, no hay PDF de follow-up.",
                    pedido.getId());
            return;
        }

        // Toggles del operador en /configuracion. Si alguno está deshabilitado,
        // ese canal se saltea como si no estuviera configurado a nivel sistema.
        NotificacionesAutoConfigDTO autoCfg = configuracionService.getNotificacionesAuto();
        boolean autoEmail = autoCfg.emailAutoPedido();
        boolean autoWhatsapp = autoCfg.whatsappAutoPedido();

        if (!autoEmail && !autoWhatsapp) {
            log.info("Pedido {} — auto-send deshabilitado para email y whatsapp en /configuracion.",
                    pedido.getId());
            return;
        }

        // Chequeamos config a nivel sistema primero (env vars Meta) para
        // distinguir en los logs entre "WhatsApp intentado y falló" vs
        // "WhatsApp deshabilitado, ni se intentó".
        boolean whatsappConfigurado = whatsappService.motivoNoConfigurado().isEmpty();
        boolean whatsappIntentado = false;
        boolean whatsappOk = false;

        if (tieneTelefono && whatsappConfigurado && autoWhatsapp) {
            whatsappIntentado = true;
            whatsappOk = whatsappService.enviarPedidoSync(pedido);
        }

        if (!whatsappOk && tieneEmail && autoEmail) {
            if (whatsappIntentado) {
                log.info("Pedido {} — WhatsApp falló, fallback a email.", pedido.getId());
            } else if (tieneTelefono && !autoWhatsapp) {
                log.info("Pedido {} — auto-WhatsApp deshabilitado en config, mandando email.", pedido.getId());
            } else if (tieneTelefono) {
                log.info("Pedido {} — WhatsApp deshabilitado a nivel sistema, mandando email.", pedido.getId());
            }
            emailService.enviarPedidoSync(pedido);
        }
    }

    /** True si la sesión asociada tiene ítems escaneados que NO terminaron en
     *  el pedido — es decir, hay material para el PDF de "vistos sin comprar".
     *  False si no hay sesión asociada o si todos los scans fueron comprados. */
    private boolean hayItemsExtraQueMandar(PedidoShowroom pedido) {
        Optional<SesionShowroom> sesion = sesionRepository.findByPedidoIdWithItems(pedido.getId());
        if (sesion.isEmpty()) return false;
        Set<String> skusComprados = pedido.getItems().stream()
                .map(PedidoShowroomItem::getSku)
                .filter(Objects::nonNull)
                .collect(Collectors.toSet());
        return sesion.get().getItems().stream()
                .anyMatch(it -> !skusComprados.contains(it.getSku()));
    }
}
