package ar.com.leo.showroom.common.web;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;

/**
 * Logea cada request HTTP con método, URI, status, duración e IP del cliente.
 * Pensado para diagnóstico del tipo "¿llegó la request al backend?" cuando algo
 * falla desde una PC cliente. Sin esto, un network error en el frontend no deja
 * rastro server-side.
 *
 * <p>Excluye {@code /health} y {@code /events} porque generan ruido constante:
 * health se pollea desde el frontend cada ~30s y events es un SSE persistente
 * que vive horas en una sola conexión.
 */
@Slf4j
@Component
public class RequestLoggingFilter extends OncePerRequestFilter {

    @Override
    protected boolean shouldNotFilter(HttpServletRequest req) {
        String uri = req.getRequestURI();
        return uri.endsWith("/health") || uri.endsWith("/events");
    }

    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain)
            throws ServletException, IOException {
        long start = System.currentTimeMillis();
        try {
            chain.doFilter(req, res);
        } finally {
            long elapsed = System.currentTimeMillis() - start;
            String qs = req.getQueryString();
            log.info("{} {}{} -> {} ({}ms) from {}",
                    req.getMethod(),
                    req.getRequestURI(),
                    qs == null ? "" : "?" + qs,
                    res.getStatus(),
                    elapsed,
                    req.getRemoteAddr());
        }
    }
}
