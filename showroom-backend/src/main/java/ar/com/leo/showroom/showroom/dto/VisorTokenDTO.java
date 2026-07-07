package ar.com.leo.showroom.showroom.dto;

/** Token del visor de la sesión activa del operador (null si no hay sesión).
 *  Respuesta del endpoint autenticado GET /api/showroom/visor/token. */
public record VisorTokenDTO(String token) {}
