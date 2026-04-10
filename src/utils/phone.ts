/**
 * Normaliza un número de teléfono a solo dígitos para comparación.
 *
 * Casos manejados:
 *   "573001234567"     → "3001234567"  (con código de país 57, 10 dígitos locales)
 *   "+57 300 123 4567" → "3001234567"
 *   "3001234567"       → "3001234567"  (ya sin código de país)
 *   null/undefined     → null
 *
 * @param phone    El teléfono a normalizar (puede tener +, espacios, guiones)
 * @param dialCode Código de país sin "+" (por defecto "57" para Colombia)
 */
export function normalizePhone(phone: string | null | undefined, dialCode = '57'): string | null {
    if (!phone) return null;
    const digits = phone.replace(/\D/g, '');
    if (digits.length < 7) return null;
    // Si comienza con el código de país y la longitud es dialCode + 10 dígitos locales
    if (digits.startsWith(dialCode) && digits.length === dialCode.length + 10) {
        return digits.slice(dialCode.length);
    }
    return digits;
}

/**
 * Compara dos teléfonos normalizados. Retorna true si son el mismo número.
 */
export function phonesMatch(
    a: string | null | undefined,
    b: string | null | undefined,
    dialCode = '57'
): boolean {
    const na = normalizePhone(a, dialCode);
    const nb = normalizePhone(b, dialCode);
    if (!na || !nb) return false;
    return na === nb;
}
