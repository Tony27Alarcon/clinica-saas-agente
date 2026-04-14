/**
 * Utilidades para manejar el tiempo con contexto de negocio.
 */
import { logger } from './logger';

/**
 * Mapa de aliases no-IANA → IANA. Para valores conocidos incorrectos en la BD
 * (ej. clínicas que tienen 'Bogota' en lugar de 'America/Bogota').
 */
const TIMEZONE_ALIASES: Record<string, string> = {
    'Medellin/Colombia': 'America/Bogota',
    'Bogota/Colombia':   'America/Bogota',
    'Colombia':          'America/Bogota',
    'Medellin':          'America/Bogota',
    'Bogota':            'America/Bogota',
    'Cali/Colombia':     'America/Bogota',
    'Lima/Peru':         'America/Lima',
    'Ciudad de Mexico':  'America/Mexico_City',
    'Buenos Aires':      'America/Argentina/Buenos_Aires',
    'Santiago/Chile':    'America/Santiago',
};

/**
 * Normaliza un timezone a un valor IANA válido.
 * - Si está vacío → 'America/Bogota'.
 * - Si es alias conocido → su IANA equivalente (log warn para que se corrija en BD).
 * - Si es IANA válido → se mantiene.
 * - Si es inválido → fallback a 'America/Bogota'.
 */
export function normalizeTimezone(tz: string): string {
    if (!tz) return 'America/Bogota';
    if (TIMEZONE_ALIASES[tz]) {
        logger.warn(`[time] Timezone no-IANA "${tz}" → "${TIMEZONE_ALIASES[tz]}". Actualiza companies.timezone en la BD.`);
        return TIMEZONE_ALIASES[tz];
    }
    try {
        Intl.DateTimeFormat('en-US', { timeZone: tz });
        return tz;
    } catch {
        logger.warn(`[time] Timezone inválido: "${tz}", usando America/Bogota como fallback.`);
        return 'America/Bogota';
    }
}

export const getColombianContext = () => {
    // Configuración para Colombia (UTC-5)
    const options: Intl.DateTimeFormatOptions = {
        timeZone: 'America/Bogota',
        hour12: true,
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    };

    const now = new Date();
    const formatter = new Intl.DateTimeFormat('es-CO', options);
    const parts = formatter.formatToParts(now);

    const getPart = (type: string) => parts.find(p => p.type === type)?.value;

    // Obtenemos la hora en formato 24h para determinar la parte del día de forma más robusta
    const hourForPart = parseInt(new Intl.DateTimeFormat('es-CO', {
        timeZone: 'America/Bogota',
        hour: '2-digit',
        hour12: false
    }).format(now));

    let partOfDay = 'Noche';
    if (hourForPart >= 5 && hourForPart < 12) partOfDay = 'Mañana';
    else if (hourForPart >= 12 && hourForPart < 18) partOfDay = 'Tarde';

    const fullDate = formatter.format(now);
    const dayName = getPart('weekday');

    return {
        fullDate,
        dayName,
        partOfDay,
        time: `${getPart('hour')}:${getPart('minute')} ${getPart('dayPeriod') || ''}`,
        raw: now.toISOString()
    };
};

/**
 * Formatea un ISO UTC en la zona horaria de una clínica.
 *
 * Devuelve:
 *  - `date`:  fecha larga localizada (ej: "martes 14 de abril de 2026")
 *  - `time`:  hora local (ej: "02:00 p. m.")
 *  - `full`:  combinación date + time
 *  - `relativeLabel`: etiqueta relativa útil para el agente IA
 *    ("hoy a las 02:00 p. m.", "mañana 09:30 a. m.",
 *     "sábado 18 abr 03:00 p. m.", "hace 2 h (recién finalizada)")
 */
export function formatInTimezone(
    utcIso: string,
    tz: string,
    locale: string = 'es-CO'
): { date: string; time: string; full: string; relativeLabel: string } {
    const safeTz = normalizeTimezone(tz);
    const d = new Date(utcIso);

    const dateFmt = new Intl.DateTimeFormat(locale, {
        timeZone: safeTz,
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
    });
    const timeFmt = new Intl.DateTimeFormat(locale, {
        timeZone: safeTz,
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
    });
    const shortDateFmt = new Intl.DateTimeFormat(locale, {
        timeZone: safeTz,
        weekday: 'short',
        day: 'numeric',
        month: 'short',
    });

    const date = dateFmt.format(d);
    const time = timeFmt.format(d);
    const full = `${date}, ${time}`;

    // Determinar día relativo comparando Y-M-D en la TZ de la clínica
    const ymdFmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: safeTz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    });
    const ymdOf = (dt: Date) => ymdFmt.format(dt); // "YYYY-MM-DD"
    const now = new Date();
    const todayYmd = ymdOf(now);
    const targetYmd = ymdOf(d);

    const oneDayMs = 86_400_000;
    const tomorrowYmd = ymdOf(new Date(now.getTime() + oneDayMs));
    const yesterdayYmd = ymdOf(new Date(now.getTime() - oneDayMs));

    const diffMs = d.getTime() - now.getTime();
    const absHours = Math.abs(diffMs) / 3_600_000;

    let relativeLabel: string;
    if (targetYmd === todayYmd) {
        if (diffMs < 0 && absHours <= 3) {
            const h = Math.round(absHours);
            relativeLabel = `hace ${h}h — recién finalizada/en curso (${time})`;
        } else if (diffMs < 0) {
            relativeLabel = `hoy temprano (${time})`;
        } else if (absHours < 1) {
            const m = Math.round((diffMs / 60_000));
            relativeLabel = `hoy en ${m} min (${time})`;
        } else {
            relativeLabel = `hoy a las ${time}`;
        }
    } else if (targetYmd === tomorrowYmd) {
        relativeLabel = `mañana ${time}`;
    } else if (targetYmd === yesterdayYmd) {
        relativeLabel = `ayer ${time}`;
    } else {
        relativeLabel = `${shortDateFmt.format(d)} ${time}`;
    }

    return { date, time, full, relativeLabel };
}
