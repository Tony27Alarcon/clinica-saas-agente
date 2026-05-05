import { vi, describe, it, expect, beforeEach } from 'vitest';

// ── Mocks hoisted ────────────────────────────────────────────────────────────

const { tableState, storageState, gcalCancelMock, mockLogger } = vi.hoisted(() => {
    type TableState = {
        rows: Record<string, any[]>;
        deleteCounts: Record<string, number>;
        updateCounts: Record<string, number>;
        deleteShouldFail?: { table: string; message: string };
    };
    const tableState: TableState = {
        rows: {},
        deleteCounts: {},
        updateCounts: {},
    };
    const storageState = {
        removed: [] as string[],
        shouldFail: false as boolean | string,
    };
    const gcalCancelMock = vi.fn();
    const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    return { tableState, storageState, gcalCancelMock, mockLogger };
});

// Builder de chain por tabla. Cada llamada a `.from(table)` devuelve un nuevo
// chain con filtros acumulables. Los terminales (`.maybeSingle()`,
// `.select(_, { count, head: true })`, await directo, etc.) leen el estado.
function makeChain(table: string) {
    let mode: 'select' | 'delete' | 'update' = 'select';
    let updates: Record<string, any> = {};
    let countMode = false;
    let headOnly = false;
    const filters: Array<{ op: 'eq' | 'not'; col: string; val: any }> = [];

    const applyFilters = (rows: any[]) =>
        rows.filter(r =>
            filters.every(f => {
                if (f.op === 'eq') return r[f.col] === f.val;
                if (f.op === 'not') return r[f.col] !== null && r[f.col] !== undefined;
                return true;
            })
        );

    const chain: any = {
        select(_cols?: string, opts?: { count?: string; head?: boolean }) {
            mode = 'select';
            if (opts?.count) countMode = true;
            if (opts?.head) headOnly = true;
            return chain;
        },
        delete(opts?: { count?: string }) {
            mode = 'delete';
            if (opts?.count) countMode = true;
            return chain;
        },
        update(values: Record<string, any>, opts?: { count?: string }) {
            mode = 'update';
            updates = values;
            if (opts?.count) countMode = true;
            return chain;
        },
        eq(col: string, val: any) {
            filters.push({ op: 'eq', col, val });
            return chain;
        },
        not(col: string, _is: 'is', _val: null) {
            filters.push({ op: 'not', col, val: null });
            return chain;
        },
        maybeSingle() {
            const matched = applyFilters(tableState.rows[table] ?? []);
            return Promise.resolve({ data: matched[0] ?? null, error: null });
        },
        then(resolve: any, reject: any) {
            const rows = tableState.rows[table] ?? [];
            const matched = applyFilters(rows);
            try {
                if (mode === 'select') {
                    if (headOnly && countMode) {
                        return resolve({ data: null, count: matched.length, error: null });
                    }
                    return resolve({ data: matched, error: null });
                }
                if (mode === 'delete') {
                    if (tableState.deleteShouldFail?.table === table) {
                        return resolve({
                            data: null,
                            count: 0,
                            error: { message: tableState.deleteShouldFail.message },
                        });
                    }
                    const remaining = rows.filter(r => !matched.includes(r));
                    tableState.rows[table] = remaining;
                    tableState.deleteCounts[table] = (tableState.deleteCounts[table] ?? 0) + matched.length;
                    // Simula ON DELETE CASCADE cuando se borra desde `contacts`
                    if (table === 'contacts') {
                        const deletedIds = matched.map(r => r.id);
                        const childTables = [
                            'conversations', 'appointments', 'clinical_forms',
                            'contacts_notas', 'follow_ups', 'scheduled_reminders',
                        ];
                        for (const child of childTables) {
                            const childRows = tableState.rows[child] ?? [];
                            tableState.rows[child] = childRows.filter(
                                r => !deletedIds.includes(r.contact_id)
                            );
                        }
                    }
                    return resolve({ data: matched, count: matched.length, error: null });
                }
                if (mode === 'update') {
                    matched.forEach(r => Object.assign(r, updates));
                    tableState.updateCounts[table] = (tableState.updateCounts[table] ?? 0) + matched.length;
                    return resolve({ data: matched, count: matched.length, error: null });
                }
                return resolve({ data: matched, error: null });
            } catch (err) {
                return reject ? reject(err) : Promise.reject(err);
            }
        },
    };
    return chain;
}

vi.mock('../config/supabase', () => ({
    supabase: {
        schema: vi.fn(() => ({ from: (table: string) => makeChain(table) })),
        storage: {
            from: vi.fn(() => ({
                remove: vi.fn(async (paths: string[]) => {
                    if (storageState.shouldFail) {
                        return {
                            data: null,
                            error: { message: typeof storageState.shouldFail === 'string' ? storageState.shouldFail : 'storage_failed' },
                        };
                    }
                    storageState.removed.push(...paths);
                    return { data: paths.map(p => ({ name: p })), error: null };
                }),
            })),
        },
    },
}));

vi.mock('../config/env', () => ({
    env: { GOOGLE_SERVICE_ACCOUNT_JSON: { client_email: 'sa@test.com', private_key: 'KEY' } },
}));

vi.mock('../utils/logger', () => ({ logger: mockLogger }));

vi.mock('../services/google-calendar.service', () => ({
    GoogleCalendarService: { cancelAppointmentEvent: gcalCancelMock },
}));

import { ClinicasDbService } from '../services/clinicas-db.service';

// ── Helpers ──────────────────────────────────────────────────────────────────

const COMPANY = 'company-1';
const PHONE = '51999000111';
const CONTACT_ID = 'contact-uuid-1';

function resetState() {
    tableState.rows = {};
    tableState.deleteCounts = {};
    tableState.updateCounts = {};
    tableState.deleteShouldFail = undefined;
    storageState.removed = [];
    storageState.shouldFail = false;
    gcalCancelMock.mockReset();
    mockLogger.info.mockReset();
    mockLogger.warn.mockReset();
    mockLogger.error.mockReset();
}

function seedFullContact() {
    tableState.rows.contacts = [{ id: CONTACT_ID, company_id: COMPANY, phone: PHONE }];
    tableState.rows.appointments = [
        { id: 'a1', company_id: COMPANY, contact_id: CONTACT_ID, gcal_event_id: 'gcal-evt-1', gcal_calendar_id: 'cal-1' },
    ];
    tableState.rows.media_assets = [
        {
            id: 'm1', company_id: COMPANY, contact_id: CONTACT_ID,
            storage_path: 'foo/img-1.jpg', storage_bucket: 'mensajes',
        },
        {
            id: 'm2', company_id: COMPANY, contact_id: CONTACT_ID,
            storage_path: 'foo/aud-1.ogg', storage_bucket: 'mensajes',
        },
    ];
    tableState.rows.clinical_forms = [
        {
            id: 'f1', company_id: COMPANY, contact_id: CONTACT_ID,
            pdf_url: 'https://x.supabase.co/storage/v1/object/public/mensajes/forms/ficha-1.pdf',
        },
    ];
    tableState.rows.logs_eventos = [
        { id: 1, company_id: COMPANY, contact_id: CONTACT_ID, conversation_id: 'cv-1' },
        { id: 2, company_id: COMPANY, contact_id: CONTACT_ID, conversation_id: 'cv-1' },
    ];
    // Tablas con CASCADE: el delete de contacts las dejará vacías. Para el
    // test del happy path simulamos eso vaciándolas antes de la verificación
    // (ver mock — lo hace el delete sobre `contacts`).
    tableState.rows.conversations = [];
    tableState.rows.contacts_notas = [];
    tableState.rows.follow_ups = [];
    tableState.rows.scheduled_reminders = [];
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('ClinicasDbService.purgeContactCompletely', () => {
    let spyGCalConfigs: ReturnType<typeof vi.spyOn>;
    let spyStaffOAuth: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        resetState();
        spyGCalConfigs = vi.spyOn(ClinicasDbService, 'getGCalConfigs').mockResolvedValue([
            {
                calendarId: 'cal-1',
                workStart: '09:00',
                workEnd: '18:00',
                workDays: [1, 2, 3, 4, 5],
                defaultSlotMin: 60,
                timezone: 'America/Bogota',
                staffName: 'Dr. X',
                staffSpecialty: '',
                staffId: 'staff-uuid-1',
            } as any,
        ]);
        spyStaffOAuth = vi.spyOn(ClinicasDbService, 'getStaffOAuthTokens').mockResolvedValue({
            refreshToken: 'rt-1',
            email: 'dr@x.com',
        });
        gcalCancelMock.mockResolvedValue(undefined);
    });

    it('contact no existe → ok+noop sin tocar nada', async () => {
        tableState.rows.contacts = [];
        const result = await ClinicasDbService.purgeContactCompletely(COMPANY, PHONE);
        expect(result.ok).toBe(true);
        expect(result.contactId).toBeNull();
        expect(result.warnings).toContain('contact_not_found');
        expect(gcalCancelMock).not.toHaveBeenCalled();
    });

    it('happy path: cancela GCal, borra storage, anonimiza logs, borra contact', async () => {
        seedFullContact();
        const result = await ClinicasDbService.purgeContactCompletely(COMPANY, PHONE);

        expect(result.ok).toBe(true);
        expect(result.contactId).toBe(CONTACT_ID);
        expect(result.counts.gcalEventsCancelled).toBe(1);
        expect(result.counts.storageFilesRemoved).toBe(3); // 2 media + 1 PDF
        expect(result.counts.mediaAssetsRows).toBe(2);
        expect(result.counts.logsAnonymized).toBe(2);
        expect(gcalCancelMock).toHaveBeenCalledWith('cal-1', 'gcal-evt-1', 'rt-1');
        expect(storageState.removed).toEqual(
            expect.arrayContaining(['foo/img-1.jpg', 'foo/aud-1.ogg', 'forms/ficha-1.pdf'])
        );
        // logs_eventos anonimizados (contact_id=null)
        expect(tableState.rows.logs_eventos!.every(r => r.contact_id === null && r.conversation_id === null)).toBe(true);
        // contacts table vacía
        expect(tableState.rows.contacts).toEqual([]);
    });

    it('GCal cancel falla → warning pero la purga sigue', async () => {
        seedFullContact();
        gcalCancelMock.mockRejectedValueOnce(new Error('gcal_500'));
        const result = await ClinicasDbService.purgeContactCompletely(COMPANY, PHONE);

        expect(result.ok).toBe(true);
        expect(result.counts.gcalEventsCancelled).toBe(0);
        expect(result.warnings.some(w => w.startsWith('gcal_cancel_failed'))).toBe(true);
    });

    it('storage remove falla → warning, no aborta', async () => {
        seedFullContact();
        storageState.shouldFail = 'permission_denied';
        const result = await ClinicasDbService.purgeContactCompletely(COMPANY, PHONE);

        expect(result.ok).toBe(true);
        expect(result.warnings.some(w => w.includes('storage_remove_failed'))).toBe(true);
    });

    it('delete final de contacts falla → ok=false, NO crear seed', async () => {
        seedFullContact();
        tableState.deleteShouldFail = { table: 'contacts', message: 'fk_violation' };
        const result = await ClinicasDbService.purgeContactCompletely(COMPANY, PHONE);

        expect(result.ok).toBe(false);
        expect(result.error).toContain('contact_delete_failed');
        // contacts NO se borró
        expect(tableState.rows.contacts).toHaveLength(1);
    });

    it('verifyContactPurged detecta residuos en tablas hijas', async () => {
        // Caller borra contacts pero deja un appointment colgado (CASCADE no aplicado en prod)
        tableState.rows.contacts = [];
        tableState.rows.appointments = [
            { id: 'orphan-1', company_id: COMPANY, contact_id: CONTACT_ID },
        ];
        const v = await ClinicasDbService.verifyContactPurged(COMPANY, CONTACT_ID);
        expect(v.clean).toBe(false);
        expect(v.residue.some(r => r.startsWith('appointments:'))).toBe(true);
    });

    it('verifyContactPurged retorna clean cuando todo está vacío', async () => {
        tableState.rows = {
            contacts: [], conversations: [], appointments: [], clinical_forms: [],
            contacts_notas: [], follow_ups: [], scheduled_reminders: [], media_assets: [],
        };
        const v = await ClinicasDbService.verifyContactPurged(COMPANY, CONTACT_ID);
        expect(v.clean).toBe(true);
        expect(v.residue).toEqual([]);
    });
});
