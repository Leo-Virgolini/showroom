package ar.com.leo.showroom.common;

/**
 * Datos de marca que aparecen en material de cara al cliente (emails y PDFs).
 *
 * <p>Viven acá y no en cada servicio porque el mismo cliente puede recibir un
 * presupuesto, una cotización financiera y el PDF de ítems de interés el mismo
 * día: si la URL o el nombre divergen entre esos canales, se nota. El nombre de
 * la empresa es "Kitchen Tools" — ojo que {@code "KT GASTRO"} NO es la marca
 * sino el nombre de la lista de precios en DUX, y ese string tiene que coincidir
 * literal con lo que hay cargado allá.
 */
public final class Branding {

    private Branding() {
    }

    /** Nombre comercial, tal como se le muestra al cliente. */
    public static final String EMPRESA = "Kitchen Tools";

    /** Tienda online — destino de los links (con barra final). */
    public static final String TIENDA_URL = "https://kitchentools.com.ar/";

    /** Tienda online — texto visible del link (sin esquema ni barra). */
    public static final String TIENDA_LABEL = "kitchentools.com.ar";
}
