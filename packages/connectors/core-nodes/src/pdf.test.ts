import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createTestNodeContext } from '@code-brothers/node-sdk';
import { generateTextPdf } from './pdf.js';
import { pdfGenerateNode } from './nodes.js';

describe('generateTextPdf', () => {
  it('produces a %PDF buffer', async () => {
    const pdf = await generateTextPdf({
      title: 'Meeting Notes',
      lines: ['First line', 'Second line'],
    });
    assert.equal(pdf.subarray(0, 4).toString('latin1'), '%PDF');
    assert.ok(pdf.toString('latin1').includes('Meeting Notes'));
  });
});

describe('pdfGenerate node', () => {
  it('outputs base64 that decodes to bytes starting with %PDF', async () => {
    const { ctx } = createTestNodeContext({
      parameters: { title: 'Doc', text: 'alpha\nbeta\ngamma' },
    });
    const [out] = await pdfGenerateNode.execute(ctx, [{ json: {} }]);
    const json = out?.[0]?.json as {
      filename: string;
      mimeType: string;
      base64: string;
    };
    assert.equal(json.filename, 'document.pdf');
    assert.equal(json.mimeType, 'application/pdf');
    const bytes = Buffer.from(json.base64, 'base64');
    assert.equal(bytes.subarray(0, 4).toString('latin1'), '%PDF');
  });
});
