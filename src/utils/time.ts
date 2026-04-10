/**
 * Utilidades para manejar el tiempo con contexto de negocio en Colombia.
 */
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

    const hour24 = now.getUTCHours() - 5; // Ajuste manual simple para lógica de parte del día si es necesario, 
                                         // pero Intl ya nos da la hora formateada.
    
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
