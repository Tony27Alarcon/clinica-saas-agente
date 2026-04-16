import { vi, describe, it, expect, beforeEach } from 'vitest';

// ── Variables hoisted para usar dentro de vi.mock factories ──────────────────

const { mockRpc, mockDbChain, mockGetAvailableSlots, mockEnv, mockLoggerWarn } = vi.hoisted(() => {
    const mockRpc = vi.fn();
    const mockDbChain = {
        from: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn(),
        rpc: mockRpc,
    };
    const mockGetAvailableSlots = vi.fn();
    const mockEnv: Record<string, any> = {
        GCAL_LOOK_AHEAD_DAYS: 14,
        GOOGLE_SERVICE_ACCOUNT_JSON: { client_email: 'sa@test.com', private_key: 'FAKE' },
    };
    const mockLoggerWarn = vi.fn();
    return { mockRpc, mockDbChain, mockGetAvailableSlots, mockEnv, mockLoggerWarn };
});

// ── Mocks de módulos ─────────────────────────────────────────────────────────

vi.mock('../config/supabase', () => ({
    supabase: { schema: vi.fn(() => mockDbChain) },
}));

vi.mock('../services/google-calendar.service', () => ({
    GoogleCalendarService: {
        getAvailableSlots: mockGetAvailableSlots,
    },
}));

vi.mock('../config/env', () => ({
    env: mockEnv,
}));

vi.mock('../utils/logger', () => ({
    logger: { info: vi.fn(), warn: mockLoggerWarn, error: vi.fn(), debug: vi.fn() },
}));

// ── Import del servicio bajo test ────────────────────────────────────────────

import { ClinicasDbService } from '../services/clinicas-db.service';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeGCalConfig(overrides: Record<string, any> = {}) {
    return {
        calendarId: 'cal-1',
        workStart: '09:00',
        workEnd: '18:00',
        workDays: [1, 2, 3, 4, 5],
        defaultSlotMin: 60,
        timezone: 'America/Bogota',
        staffName: 'Dr. X',
        staffSpecialty: 'Estética',
        staffId: null,
        ...overrides,
    };
}

function makeFakeGCalSlot(id: string, startsAt: string) {
    return {
        slot_id: `gcal_cal-1_${startsAt}`,
        staff_name: 'Dr. X',
        staff_specialty: 'Estética',
        starts_at: startsAt,
        ends_at: new Date(new Date(startsAt).getTime() + 60 * 60_000).toISOString(),
        duration_min: 60,
        source: 'gcal' as const,
    };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('ClinicasDbService.getFreeSlotsMerged', () => {
    let spyGetGCalConfigs: ReturnType<typeof vi.spyOn>;
    let spyGetStaffOAuthTokens: ReturnType<typeof vi.spyOn>;
    let spyGetFreeSlots: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.resetAllMocks();
        mockEnv.GOOGLE_SERVICE_ACCOUNT_JSON = { client_email: 'sa@test.com', private_key: 'FAKE' };

        spyGetGCalConfigs = vi.spyOn(ClinicasDbService, 'getGCalConfigs');
        spyGetStaffOAuthTokens = vi.spyOn(ClinicasDbService, 'getStaffOAuthTokens');
        spyGetFreeSlots = vi.spyOn(ClinicasDbService, 'getFreeSlots');
    });

    // ── Test 1 ───────────────────────────────────────────────────────────────

    it('sin gcal_config → usa BD como fallback y retorna source "db"', async () => {
        spyGetGCalConfigs.mockResolvedValue([]);
        spyGetFreeSlots.mockResolvedValue([{ slot_id: 'uuid-1', starts_at: '2026-04-14T14:00:00Z' }]);

        const result = await ClinicasDbService.getFreeSlotsMerged('company-1');

        expect(spyGetGCalConfigs).toHaveBeenCalledWith('company-1');
        expect(spyGetFreeSlots).toHaveBeenCalledWith('company-1', undefined, 10);
        expect(result.source).toBe('db');
        expect(result.slots).toHaveLength(1);
    });

    // ── Test 2 ───────────────────────────────────────────────────────────────

    it('con gcal_config y slots de GCal → retorna source "gcal" sin fallback a BD', async () => {
        spyGetGCalConfigs.mockResolvedValue([makeGCalConfig()]);
        mockGetAvailableSlots.mockResolvedValue([
            makeFakeGCalSlot('1', '2026-04-14T14:00:00.000Z'),
        ]);

        const result = await ClinicasDbService.getFreeSlotsMerged('company-1');

        expect(mockGetAvailableSlots).toHaveBeenCalledOnce();
        expect(result.source).toBe('gcal');
        expect(result.slots).toHaveLength(1);
        expect(spyGetFreeSlots).not.toHaveBeenCalled();
    });

    // ── Test 3 (CRÍTICO) ─────────────────────────────────────────────────────

    it('GCal lanza error → retorna vacío sin fallback a BD', async () => {
        spyGetGCalConfigs.mockResolvedValue([makeGCalConfig()]);
        mockGetAvailableSlots.mockRejectedValue(new Error('Network timeout'));

        const result = await ClinicasDbService.getFreeSlotsMerged('company-1');

        expect(result.source).toBe('gcal');
        expect(result.slots).toHaveLength(0);
        expect(spyGetFreeSlots).not.toHaveBeenCalled();
    });

    // ── Test 4 ───────────────────────────────────────────────────────────────

    it('GCal devuelve 0 slots → fallback a BD', async () => {
        spyGetGCalConfigs.mockResolvedValue([makeGCalConfig()]);
        mockGetAvailableSlots.mockResolvedValue([]);
        spyGetFreeSlots.mockResolvedValue([{ slot_id: 'uuid-db-1', starts_at: '2026-04-14T14:00:00Z' }]);

        const result = await ClinicasDbService.getFreeSlotsMerged('company-1');

        expect(spyGetFreeSlots).toHaveBeenCalledOnce();
        expect(result.source).toBe('db');
        expect(result.slots[0].slot_id).toBe('uuid-db-1');
    });

    // ── Test 5 ───────────────────────────────────────────────────────────────

    it('config con staffId → llama getStaffOAuthTokens y pasa refreshToken a GCal', async () => {
        spyGetGCalConfigs.mockResolvedValue([makeGCalConfig({ staffId: 'staff-uuid-123' })]);
        spyGetStaffOAuthTokens.mockResolvedValue({ refreshToken: 'rt-token', email: 'dr@clinic.com' });
        mockGetAvailableSlots.mockResolvedValue([makeFakeGCalSlot('1', '2026-04-14T14:00:00.000Z')]);

        await ClinicasDbService.getFreeSlotsMerged('company-1');

        expect(spyGetStaffOAuthTokens).toHaveBeenCalledWith('staff-uuid-123');
        expect(mockGetAvailableSlots).toHaveBeenCalledWith(
            expect.objectContaining({ calendarId: 'cal-1' }),
            60,         // defaultSlotMin
            10,         // limit default
            14,         // lookAheadDays
            'rt-token', // refreshToken
        );
    });

    // ── Test 6 ───────────────────────────────────────────────────────────────

    it('sin refreshToken y sin SA JSON → calendario omitido con warning', async () => {
        mockEnv.GOOGLE_SERVICE_ACCOUNT_JSON = null;

        spyGetGCalConfigs.mockResolvedValue([makeGCalConfig({ staffId: null })]);
        spyGetFreeSlots.mockResolvedValue([]);

        await ClinicasDbService.getFreeSlotsMerged('company-1');

        expect(mockGetAvailableSlots).not.toHaveBeenCalled();
        expect(mockLoggerWarn).toHaveBeenCalledWith(
            expect.stringContaining('sin OAuth ni SA'),
        );
    });

    // ── Test 7 ───────────────────────────────────────────────────────────────

    it('múltiples calendarios: mezcla, ordena por starts_at y limita', async () => {
        spyGetGCalConfigs.mockResolvedValue([
            makeGCalConfig({ calendarId: 'cal-A' }),
            makeGCalConfig({ calendarId: 'cal-B' }),
        ]);

        // Cal-A: slots tardíos
        mockGetAvailableSlots
            .mockResolvedValueOnce([
                { ...makeFakeGCalSlot('a1', '2026-04-14T16:00:00.000Z'), slot_id: 'gcal_cal-A_2026-04-14T16:00:00.000Z' },
                { ...makeFakeGCalSlot('a2', '2026-04-14T17:00:00.000Z'), slot_id: 'gcal_cal-A_2026-04-14T17:00:00.000Z' },
            ])
            // Cal-B: slots tempranos
            .mockResolvedValueOnce([
                { ...makeFakeGCalSlot('b1', '2026-04-14T14:00:00.000Z'), slot_id: 'gcal_cal-B_2026-04-14T14:00:00.000Z' },
                { ...makeFakeGCalSlot('b2', '2026-04-14T15:00:00.000Z'), slot_id: 'gcal_cal-B_2026-04-14T15:00:00.000Z' },
            ]);

        const result = await ClinicasDbService.getFreeSlotsMerged('company-1', undefined, undefined, 3);

        expect(result.slots).toHaveLength(3);
        // Debe estar ordenado cronológicamente: B-14:00, B-15:00, A-16:00
        expect(result.slots[0].slot_id).toBe('gcal_cal-B_2026-04-14T14:00:00.000Z');
        expect(result.slots[1].slot_id).toBe('gcal_cal-B_2026-04-14T15:00:00.000Z');
        expect(result.slots[2].slot_id).toBe('gcal_cal-A_2026-04-14T16:00:00.000Z');
        expect(result.source).toBe('gcal');
    });

    // ── Test 8 ───────────────────────────────────────────────────────────────

    it('slotDurationMin override reemplaza config.defaultSlotMin', async () => {
        spyGetGCalConfigs.mockResolvedValue([makeGCalConfig({ defaultSlotMin: 60 })]);
        mockGetAvailableSlots.mockResolvedValue([makeFakeGCalSlot('1', '2026-04-14T14:00:00.000Z')]);

        await ClinicasDbService.getFreeSlotsMerged('company-1', undefined, 30);

        expect(mockGetAvailableSlots).toHaveBeenCalledWith(
            expect.objectContaining({ defaultSlotMin: 60 }),
            30,        // ← slotDurationMin=30 overrides defaultSlotMin=60
            10,
            14,
            undefined, // no refreshToken
        );
    });
});
