export default function AuthErrorPage() {
    return (
        <div className="auth-error-shell">
            <div className="auth-error-card">
                <div className="auth-error-icon">🔒</div>
                <h1 className="auth-error-title">Enlace inválido o expirado</h1>
                <p className="auth-error-desc">
                    Este link de acceso ya no es válido. Los links del portal
                    expiran a las <strong>24 horas</strong> por seguridad.
                </p>
                <p className="auth-error-hint">
                    Escríbele al asistente en WhatsApp y pídele un nuevo link:
                    <br />
                    <span className="auth-error-quote">"dame el link del panel"</span>
                </p>
            </div>
        </div>
    );
}
