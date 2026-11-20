import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import nodemailer from 'nodemailer';
import { createTestNodeContext } from '@code-brothers/node-sdk';
import { createEmailSender } from './email.js';
import { emailSendNode } from './nodes.js';

describe('createEmailSender with nodemailer jsonTransport', () => {
  it('resolves with a messageId and the raw JSON message', async () => {
    const sender = createEmailSender({
      transport: nodemailer.createTransport({ jsonTransport: true }),
    });
    const result = await sender.send({
      from: 'sender@example.com',
      to: 'rcpt@example.com',
      subject: 'Quarterly report',
      text: 'See attached.',
    });
    assert.ok(result.messageId, 'messageId should be present');
    assert.ok(result.raw, 'raw JSON message should be surfaced');
    const parsed = JSON.parse(result.raw as string) as {
      from: { address: string };
      to: Array<{ address: string }>;
      subject: string;
      text: string;
    };
    assert.equal(parsed.subject, 'Quarterly report');
    assert.equal(parsed.from.address, 'sender@example.com');
    assert.equal(parsed.to[0]?.address, 'rcpt@example.com');
    assert.match(parsed.text, /See attached/);
  });

  it('accepts a ready-made transporter too', async () => {
    const sender = createEmailSender({
      transporter: nodemailer.createTransport({ jsonTransport: true }),
    });
    const result = await sender.send({
      from: 'a@b.c',
      to: 'd@e.f',
      subject: 'Hi',
      html: '<b>Hi</b>',
    });
    assert.ok(result.messageId);
  });
});

describe('emailSend node (jsonTransport via ctx.variables.mailTransport hook)', () => {
  it('outputs an item containing subject, to and a messageId', async () => {
    const { ctx } = createTestNodeContext({
      parameters: {
        from: 'noreply@codebrothers.example',
        to: 'customer@example.com',
        subject: 'Your order has shipped',
        text: 'Tracking soon.',
      },
      variables: { mailTransport: { jsonTransport: true } },
    });
    const [out] = await emailSendNode.execute(ctx, [{ json: {} }]);
    const json = out?.[0]?.json as {
      messageId: string;
      to: string;
      subject: string;
      raw?: string;
    };
    assert.equal(json.subject, 'Your order has shipped');
    assert.equal(json.to, 'customer@example.com');
    assert.ok(typeof json.messageId === 'string' && json.messageId.length > 0);
    assert.ok(json.raw?.includes('Your order has shipped'));
  });
});
