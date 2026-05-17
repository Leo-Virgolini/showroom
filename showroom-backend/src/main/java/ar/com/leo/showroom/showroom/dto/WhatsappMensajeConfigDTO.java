package ar.com.leo.showroom.showroom.dto;

/**
 * Cuerpo del mensaje (caption) que se manda junto al PDF por WhatsApp.
 *
 * <p>El operador lo configura desde /configuracion. El flag {@code personalizado}
 * le dice a la UI si hay un mensaje cargado en la DB (true) o si todavía no
 * se configuró ninguno (false → el PDF se va a mandar sin caption). Sirve para
 * mostrar el badge correspondiente.
 *
 * <p>Soporta el formato nativo de WhatsApp: {@code *negrita*}, {@code _itálica_},
 * {@code ~tachado~}, {@code `mono`}. El placeholder {@code {nombre}} se sustituye
 * por el nombre del cliente al enviar.
 */
public record WhatsappMensajeConfigDTO(
        String mensaje,
        boolean personalizado
) {
}
