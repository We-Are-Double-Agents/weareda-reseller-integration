#!/usr/bin/env node
/**
 * Exposes the local sandbox on a public HTTPS URL so WeAreDA can call it.
 *
 * Deliberately a standalone script: the tunnel is NOT part of the server. The
 * sandbox runs perfectly well without it - you only need a tunnel when you want
 * WeAreDA itself to reach your machine.
 *
 *   npm run tunnel
 *
 * Uses Cloudflare's quick tunnel (`cloudflared tunnel --url ...`), which needs
 * no account, no login and no configuration. ngrok works too - see below.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const RULE = '='.repeat(50);
const PORT = readPort();
const LOCAL_URL = `http://localhost:${PORT}`;

function readPort() {
  if (process.env.PORT) return process.env.PORT;
  const envPath = resolve(process.cwd(), '.env');
  if (existsSync(envPath)) {
    const match = /^PORT\s*=\s*(\d+)\s*$/m.exec(readFileSync(envPath, 'utf8'));
    if (match) return match[1];
  }
  return '3000';
}

function printInstallHelp() {
  console.log(RULE);
  console.log('cloudflared is not installed.');
  console.log(RULE);
  console.log('');
  console.log('Install it (no account or login required for a quick tunnel):');
  console.log('');
  console.log('  macOS         brew install cloudflared');
  console.log('  Linux (deb)   https://pkg.cloudflare.com/  (cloudflared package)');
  console.log('  Windows       winget install --id Cloudflare.cloudflared');
  console.log(
    '  Any platform  https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/',
  );
  console.log('');
  console.log('Then run:  npm run tunnel');
  console.log('');
  console.log('Or use ngrok instead:');
  console.log('');
  console.log(`  ngrok http ${PORT}`);
  console.log('');
  console.log('Either way, take the public https URL it prints and:');
  console.log('  1. register it as your WeAreDA `baseUrl`, and');
  console.log('  2. put it in PUBLIC_BASE_URL in .env, so invoice document_url');
  console.log('     values point at a host WeAreDA can fetch.');
  console.log('');
}

function banner(publicUrl) {
  const lines = [
    RULE,
    'WeAreDA Reseller Sandbox',
    RULE,
    '',
    'Local URL:',
    LOCAL_URL,
    '',
    'Public URL:',
    publicUrl,
    '',
    'Use this as your WeAreDA baseUrl:',
    '',
    publicUrl,
    '',
    'Health endpoint:',
    `GET ${publicUrl}/`,
    '',
    'Products:',
    `GET ${publicUrl}/products`,
    '',
    'Orders:',
    `POST ${publicUrl}/orders`,
    '',
    'Invoice document (for invoice.issued document_url):',
    `GET ${publicUrl}/fixtures/invoices/demo.pdf`,
    '',
    'Sample product images (the catalog points at the demo CDN by default):',
    `GET ${publicUrl}/fixtures/products/widget-pro.png`,
    '',
    'Next steps:',
    `  1. Add PUBLIC_BASE_URL=${publicUrl} to .env and restart the server,`,
    '     so invoice.issued events point at a document_url WeAreDA can fetch.',
    '  2. Register the baseUrl above in WeAreDA, with authType api_key and',
    '     your RESELLER_API_KEY as the apiKey.',
    '  3. Copy the webhookUrl from the connect response into',
    '     WEAREDA_WEBHOOK_URL, and your webhookSecret into',
    '     WEAREDA_WEBHOOK_SECRET.',
    '',
    'This tunnel is public while it runs. Do not leave it open unattended,',
    'and never point it at anything but this sandbox.',
    RULE,
  ];
  console.log(lines.join('\n'));
}

async function localServerIsUp() {
  try {
    const response = await fetch(`${LOCAL_URL}/healthz`, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

async function main() {
  if (!(await localServerIsUp())) {
    console.log(`No sandbox is answering on ${LOCAL_URL}.`);
    console.log('Start it first, in another terminal:  npm run dev');
    console.log('');
    console.log('Continuing anyway - the tunnel will work as soon as the server starts.');
    console.log('');
  }

  const child = spawn('cloudflared', ['tunnel', '--url', LOCAL_URL, '--no-autoupdate'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.on('error', (error) => {
    if (error.code === 'ENOENT') {
      printInstallHelp();
      process.exit(1);
    }
    console.error(error);
    process.exit(1);
  });

  let announced = false;
  const scan = (chunk) => {
    const text = chunk.toString();
    process.stderr.write(text);
    if (announced) return;
    const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(text);
    if (match) {
      announced = true;
      console.log('');
      banner(match[0]);
      console.log('');
      console.log('Tunnel is running. Press Ctrl+C to stop it.');
      console.log('');
    }
  };

  child.stdout.on('data', scan);
  child.stderr.on('data', scan);

  const stop = () => {
    child.kill('SIGINT');
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  child.on('exit', (code) => process.exit(code ?? 0));
}

main();
