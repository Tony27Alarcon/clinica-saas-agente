import { vi, describe, it, expect, beforeEach } from 'vitest';

const { mockProcesarMediaPorId, mockProcesarMedia } = vi.hoisted(() => ({
    mockProcesarMediaPorId: vi.fn(),
    mockProcesarMedia: vi.fn(),
}));

vi.mock('../services/media.service', () => ({
    MediaService: {
        procesarMediaPorId: mockProcesarMediaPorId,
        procesarMedia: mockProcesarMedia,
    },
}));

vi.mock('../utils/logger', () => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { MediaPartsService } from '../services/media-parts.service';

function fakeProcessed(overrides: Partial<{ mimeType: string; bytes: number; kind: string }> = {}) {
    const bytes = overrides.bytes ?? 50_000;
    return {
        buffer: Buffer.alloc(bytes),
        mimeType: overrides.mimeType ?? 'image/jpeg',
        publicUrl: 'https://cdn.supabase.co/storage/v1/object/public/mensajes/contact-1/x.jpg',
        kind: overrides.kind ?? 'image',
    };
}

describe('MediaPartsService.buildFromIncoming', () => {
    beforeEach(() => {
        mockProcesarMediaPorId.mockReset();
        mockProcesarMedia.mockReset();
    });

    it('retorna null si no hay mediaId ni url', async () => {
        const parts = await MediaPartsService.buildFromIncoming(
            { messageType: 'image' }, 'contact-1'
        );
        expect(parts).toBeNull();
    });

    it('construye part de imagen a partir de mediaId', async () => {
        mockProcesarMediaPorId.mockResolvedValue(fakeProcessed());
        const parts = await MediaPartsService.buildFromIncoming(
            { mediaId: 'abc', phoneNumberId: '123', messageType: 'image', caption: 'Mi receta' },
            'contact-1'
        );
        expect(parts).not.toBeNull();
        expect(parts![0]).toEqual({ type: 'text', text: 'Mi receta' });
        expect(parts![1]).toMatchObject({ type: 'image' });
    });

    it('construye part de audio con prompt de transcripción', async () => {
        mockProcesarMediaPorId.mockResolvedValue(fakeProcessed({ mimeType: 'audio/ogg', kind: 'audio' }));
        const parts = await MediaPartsService.buildFromIncoming(
            { mediaId: 'xyz', phoneNumberId: '123', messageType: 'voice' },
            'contact-1'
        );
        expect(parts).not.toBeNull();
        expect(parts!.some(p => p.type === 'file' && (p as any).mediaType === 'audio/ogg')).toBe(true);
        expect(parts!.some(p => p.type === 'text' && (p as any).text.toLowerCase().includes('transcribe'))).toBe(true);
    });

    it('rechaza MIME no permitido', async () => {
        mockProcesarMediaPorId.mockResolvedValue(fakeProcessed({ mimeType: 'application/x-sh', kind: 'document' }));
        const parts = await MediaPartsService.buildFromIncoming(
            { mediaId: 'x', phoneNumberId: '123', messageType: 'document' },
            'contact-1'
        );
        expect(parts).toBeNull();
    });

    it('rechaza imagen por encima del límite (5 MB)', async () => {
        mockProcesarMediaPorId.mockResolvedValue(fakeProcessed({ bytes: 6 * 1024 * 1024 }));
        const parts = await MediaPartsService.buildFromIncoming(
            { mediaId: 'x', phoneNumberId: '123', messageType: 'image' },
            'contact-1'
        );
        expect(parts).toBeNull();
    });

    it('construye part de PDF', async () => {
        mockProcesarMediaPorId.mockResolvedValue(fakeProcessed({ mimeType: 'application/pdf', kind: 'document' }));
        const parts = await MediaPartsService.buildFromIncoming(
            { mediaId: 'p', phoneNumberId: '123', messageType: 'document' },
            'contact-1'
        );
        expect(parts).not.toBeNull();
        expect(parts!.some(p => p.type === 'file' && (p as any).mediaType === 'application/pdf')).toBe(true);
    });

    it('degrada silenciosamente si MediaService falla', async () => {
        mockProcesarMediaPorId.mockResolvedValue(null);
        const parts = await MediaPartsService.buildFromIncoming(
            { mediaId: 'p', phoneNumberId: '123', messageType: 'image' },
            'contact-1'
        );
        expect(parts).toBeNull();
    });
});
