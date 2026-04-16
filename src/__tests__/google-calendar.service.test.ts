import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// ── Variables hoisted para usar dentro de vi.mock factories ──────────────────

const { mockFreebusyQuery, mockCalendarFactory } = vi.hoisted(() => {
    const mockFreebusyQuery = vi.fn();
    const mockCalendarFactory = vi.fn(() => ({
        freebusy: { query: mockFreebusyQuery },
        calendars: { get: vi.fn() },
        events: { insert: vi.fn(), delete: vi.fn(), patch: vi.fn() },
    }));
    return { mockFreebusyQuery, mockCalendarFactory };
});

// ── Mocks de módulos ─────────────────────────────────────────────────────────

vi.mock('googleapis', () => ({
    google: { calendar: mockCalendarFactory },
}));

vi.mock('google-auth-library', () => ({
    JWT: vi.fn().mockImplementation(() => ({})),
    OAuth2Client: vi.fn().mockImplementation(() => ({
        setCredentials: vi.fn(),
    })),
}));

vi.mock('../config/env', () => ({
    env: {
        GOOGLE_SERVICE_ACCOUNT_JSON: {
            client_email: 'sa@test.iam.gserviceaccount.com',
            private_key: '-----BEGIN RSA PRIVATE KEY-----\nFAKE\n-----END RSA PRIVATE KEY-----\n',
        },
        GOOGLE_OAUTH_CLIENT_ID: 'test-id.apps.googleusercontent.com',
        GOOGLE_OAUTH_CLIENT_SECRET: 'test-secret',
        GOOGLE_OAUTH_REDIRECT_URI: 'http://localhost:3000/auth/google/callback',
        GCAL_LOOK_AHEAD_DAYS: 14,
    },
}));

vi.mock('../utils/logger', () => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ── Import del servicio bajo test ────────────────────────────────────────────

import { GoogleCalendarService, GCalConfig } from '../services/google-calendar.service';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<GCalConfig> = {}): GCalConfig {
    return {
        calendarId: 'cal-abc-123',
        workStart: '09:00',
        workEnd: '18:00',
        workDays: [1, 2, 3, 4, 5],
        defaultSlotMin: 60,
        timezone: 'America/Bogota', // UTC-5
        staffName: 'Dr. García',
        staffSpecialty: 'Medicina Estética',
        staffId: null,
        ...overrides,
    };
}

function mockBusy(calendarId: string, busyPeriods: Array<{ start: string; end: string }>) {
    mockFreebusyQuery.mockResolvedValueOnce({
        data: {
            calendars: {
                [calendarId]: {
                    busy: busyPeriods.map(b => ({ start: b.start, end: b.end })),
                },
            },
        },
    });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('GoogleCalendarService.getAvailableSlots', () => {
    // Lunes 2026-04-13 03:00 Bogotá (08:00 UTC) — antes de horario laboral
    const FIXED_NOW = new Date('2026-04-13T08:00:00.000Z');

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(FIXED_NOW);
        mockFreebusyQuery.mockReset();
        mockCalendarFactory.mockClear();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    // ── Test 1 ───────────────────────────────────────────────────────────────

    it('retorna slots dentro del horario laboral cuando el calendario está vacío', async () => {
        const config = makeConfig();
        mockBusy('cal-abc-123', []);

        const result = await GoogleCalendarService.getAvailableSlots(config, 60, 3, 1);

        expect(result).toHaveLength(3);
        // 09:00 Bogotá = 14:00 UTC
        expect(result[0].starts_at).toBe('2026-04-13T14:00:00.000Z');
        expect(result[1].starts_at).toBe('2026-04-13T15:00:00.000Z');
        expect(result[2].starts_at).toBe('2026-04-13T16:00:00.000Z');
        expect(result[0].duration_min).toBe(60);
        expect(result[0].source).toBe('gcal');
    });

    // ── Test 2 ───────────────────────────────────────────────────────────────

    it('excluye slots que se solapan con periodos busy', async () => {
        const config = makeConfig();
        // Bloquear 09:00–10:00 Bogotá (14:00–15:00 UTC)
        mockBusy('cal-abc-123', [
            { start: '2026-04-13T14:00:00Z', end: '2026-04-13T15:00:00Z' },
        ]);

        const result = await GoogleCalendarService.getAvailableSlots(config, 60, 5, 1);

        const startsAts = result.map(s => s.starts_at);
        expect(startsAts).not.toContain('2026-04-13T14:00:00.000Z');
        // Primer slot disponible: 10:00 Bogotá = 15:00 UTC
        expect(result[0].starts_at).toBe('2026-04-13T15:00:00.000Z');
    });

    // ── Test 3 ───────────────────────────────────────────────────────────────

    it('salta días no laborales (sábado y domingo)', async () => {
        // Sábado 2026-04-11 09:00 Bogotá = 14:00 UTC
        vi.setSystemTime(new Date('2026-04-11T14:00:00.000Z'));

        const config = makeConfig({ workDays: [1, 2, 3, 4, 5] });
        mockBusy('cal-abc-123', []);

        const result = await GoogleCalendarService.getAvailableSlots(config, 60, 3, 3);

        // Todos los slots deberían estar en lunes 2026-04-13
        result.forEach(s => {
            expect(s.starts_at).toMatch(/^2026-04-13/);
        });
    });

    // ── Test 4 ───────────────────────────────────────────────────────────────

    it('respeta el parámetro limit', async () => {
        const config = makeConfig();
        mockBusy('cal-abc-123', []);

        const result = await GoogleCalendarService.getAvailableSlots(config, 30, 2, 14);

        expect(result).toHaveLength(2);
    });

    // ── Test 5 ───────────────────────────────────────────────────────────────

    it('redondea al siguiente múltiplo de slotDurationMin cuando ahora está a mitad de slot', async () => {
        // Lunes 09:20 Bogotá = 14:20 UTC
        vi.setSystemTime(new Date('2026-04-13T14:20:00.000Z'));

        const config = makeConfig();
        mockBusy('cal-abc-123', []);

        const result = await GoogleCalendarService.getAvailableSlots(config, 30, 1, 1);

        // 09:20 → siguiente múltiplo de 30 = 09:30 Bogotá = 14:30 UTC
        expect(result[0].starts_at).toBe('2026-04-13T14:30:00.000Z');
    });

    // ── Test 6 ───────────────────────────────────────────────────────────────

    it('retorna array vacío cuando todos los slots están ocupados', async () => {
        const config = makeConfig();
        // Bloquear todo el día laboral
        mockBusy('cal-abc-123', [
            { start: '2026-04-13T14:00:00Z', end: '2026-04-13T23:00:00Z' },
        ]);

        const result = await GoogleCalendarService.getAvailableSlots(config, 60, 5, 1);

        expect(result).toHaveLength(0);
    });

    // ── Test 7 ───────────────────────────────────────────────────────────────

    it('no genera slots que desbordan workEnd', async () => {
        // Lunes 16:00 Bogotá = 21:00 UTC
        vi.setSystemTime(new Date('2026-04-13T21:00:00.000Z'));

        const config = makeConfig({ workEnd: '18:00' });
        mockBusy('cal-abc-123', []);

        // Con slots de 90 min: 16:00–17:30 cabe, 17:30–19:00 NO cabe (pasa de 18:00)
        const result = await GoogleCalendarService.getAvailableSlots(config, 90, 10, 1);

        expect(result).toHaveLength(1);
        // 17:30 Bogotá = 22:30 UTC
        expect(result[0].ends_at).toBe('2026-04-13T22:30:00.000Z');
    });

    // ── Test 8 ───────────────────────────────────────────────────────────────

    it('usa calendarId "primary" en freebusy cuando hay refreshToken (modo OAuth)', async () => {
        const config = makeConfig({ calendarId: 'clinic-cal-123' });
        mockBusy('primary', []);

        const result = await GoogleCalendarService.getAvailableSlots(config, 60, 1, 1, 'valid-refresh-token');

        const callArgs = mockFreebusyQuery.mock.calls[0][0];
        expect(callArgs.requestBody.items[0].id).toBe('primary');
        // Pero el slot_id sigue usando config.calendarId
        expect(result[0].slot_id).toMatch(/^gcal_clinic-cal-123_/);
    });

    // ── Test 9 ───────────────────────────────────────────────────────────────

    it('usa config.calendarId en freebusy sin refreshToken (modo Service Account)', async () => {
        const config = makeConfig({ calendarId: 'clinic-cal-456' });
        mockBusy('clinic-cal-456', []);

        await GoogleCalendarService.getAvailableSlots(config, 60, 1, 1);

        const callArgs = mockFreebusyQuery.mock.calls[0][0];
        expect(callArgs.requestBody.items[0].id).toBe('clinic-cal-456');
    });

    // ── Test 10 ──────────────────────────────────────────────────────────────

    it('genera slots en múltiples días cuando el día actual ya terminó', async () => {
        // Lunes 18:00 Bogotá = 23:00 UTC — horario laboral terminó
        vi.setSystemTime(new Date('2026-04-13T23:00:00.000Z'));

        const config = makeConfig();
        mockBusy('cal-abc-123', []);

        const result = await GoogleCalendarService.getAvailableSlots(config, 60, 5, 3);

        expect(result.length).toBeGreaterThan(0);
        // Todos los slots deben ser después de "ahora"
        result.forEach(s => {
            expect(new Date(s.starts_at).getTime()).toBeGreaterThan(new Date('2026-04-13T23:00:00.000Z').getTime());
        });
        // Primer slot debería ser martes 2026-04-14 09:00 Bogotá = 14:00 UTC
        expect(result[0].starts_at).toBe('2026-04-14T14:00:00.000Z');
    });

    // ── Test 11 ──────────────────────────────────────────────────────────────

    it('genera slot_id con formato gcal_{calendarId}_{isoStart}', async () => {
        const config = makeConfig({ calendarId: 'my-cal@group.calendar.google.com' });
        mockBusy('my-cal@group.calendar.google.com', []);

        const result = await GoogleCalendarService.getAvailableSlots(config, 60, 1, 1);

        expect(result[0].slot_id).toBe(
            `gcal_my-cal@group.calendar.google.com_${result[0].starts_at}`
        );
    });
});
