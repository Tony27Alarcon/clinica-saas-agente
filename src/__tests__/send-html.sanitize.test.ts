import { describe, it, expect } from 'vitest';
import { sanitizeHtmlForUpload } from '../tools/send-html.tool';

describe('sanitizeHtmlForUpload', () => {
    it('quita <script> completos', () => {
        const r = sanitizeHtmlForUpload('<p>ok</p><script>alert(1)</script><p>fin</p>');
        expect(r.html).not.toContain('<script');
        expect(r.html).toContain('<p>ok</p>');
        expect(r.html).toContain('<p>fin</p>');
        expect(r.stripped).toContain('script');
    });

    it('quita <iframe> y <object>/<embed>', () => {
        const r = sanitizeHtmlForUpload('<iframe src="evil"></iframe><object>x</object><embed>y</embed>');
        expect(r.html).not.toMatch(/<iframe|<object|<embed/i);
        expect(r.stripped).toEqual(expect.arrayContaining(['iframe', 'object/embed']));
    });

    it('quita handlers on*= (onclick, onerror, onload, ...)', () => {
        const r = sanitizeHtmlForUpload(`<img src="x" onerror="alert(1)"><a href="#" onclick='hax()'>x</a>`);
        expect(r.html).not.toMatch(/\son\w+\s*=/i);
        expect(r.stripped).toContain('on*-handlers');
    });

    it('neutraliza javascript: y data:text/html en hrefs', () => {
        const r = sanitizeHtmlForUpload(`<a href="javascript:hax()">x</a><a href='data:text/html,<script>'>y</a>`);
        expect(r.html).not.toMatch(/javascript:|data:text\/html/i);
        expect(r.stripped).toContain('js-url');
    });

    it('preserva HTML benigno con estilos inline', () => {
        const safe = '<!DOCTYPE html><html><body><h1 style="color:#333">Hola</h1></body></html>';
        const r = sanitizeHtmlForUpload(safe);
        expect(r.html).toBe(safe);
        expect(r.stripped).toEqual([]);
    });
});
