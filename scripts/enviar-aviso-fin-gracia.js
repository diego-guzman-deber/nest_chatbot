/**
 * Envía la plantilla de WhatsApp "aviso de fin de periodo de gracia" a los
 * suscriptores de scripts/data/resultado-fusion.json que tengan teléfono
 * resuelto (revisarManual: false).
 *
 * La plantilla debe existir y estar APROBADA en WhatsApp Manager, con una
 * única variable de texto {{1}} en el cuerpo (el nombre del suscriptor).
 *
 * Uso:
 *   node scripts/enviar-aviso-fin-gracia.js              -> modo prueba (no manda nada, solo imprime)
 *   node scripts/enviar-aviso-fin-gracia.js --enviar      -> manda de verdad por la API de Meta
 *   node scripts/enviar-aviso-fin-gracia.js --enviar --limite 5   -> manda solo a los primeros 5 (para probar)
 *
 * Variables de entorno usadas (mismo .env del proyecto):
 *   ACCESS_TOKEN, PHONE_NUMBER_ID, VERSION
 *   WHATSAPP_TEMPLATE_GRACIA_NAME (nombre de la plantilla, ej. "aviso_fin_periodo_gracia")
 *   WHATSAPP_TEMPLATE_GRACIA_LANG (código de idioma configurado en la plantilla, ej. "es")
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const resultado = require('./data/resultado-fusion.json');

const ENVIAR = process.argv.includes('--enviar');
const limiteIdx = process.argv.indexOf('--limite');
const LIMITE = limiteIdx !== -1 ? parseInt(process.argv[limiteIdx + 1], 10) : Infinity;

const VERSION = process.env.VERSION || 'v25.0';
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
const TEMPLATE_NAME = process.env.WHATSAPP_TEMPLATE_GRACIA_NAME || 'aviso_fin_periodo_gracia';
const TEMPLATE_LANG = process.env.WHATSAPP_TEMPLATE_GRACIA_LANG || 'es';

/**
 * Normaliza un teléfono boliviano a formato E.164 sin "+" (lo que espera la
 * API de WhatsApp como "to"). Descarta los que traen varios números juntos
 * (ej. "551198949-9638") porque no se puede saber cuál es el correcto.
 */
function normalizarTelefono(telefono) {
  const soloDigitos = (telefono || '').replace(/\D/g, '');
  if (!soloDigitos) return null;
  if (soloDigitos.startsWith('591') && soloDigitos.length === 11) return soloDigitos;
  if (soloDigitos.length === 8) return `591${soloDigitos}`;
  return null; // formato raro (varios números, longitud inesperada, etc.)
}

async function enviarPlantilla(waId, nombre) {
  const url = `https://graph.facebook.com/${VERSION}/${PHONE_NUMBER_ID}/messages`;
  const data = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: waId,
    type: 'template',
    template: {
      name: TEMPLATE_NAME,
      language: { code: TEMPLATE_LANG },
      components: [
        {
          type: 'body',
          parameters: [{ type: 'text', text: nombre }],
        },
      ],
    },
  };

  const res = await axios.post(url, data, {
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
  });
  return res.status;
}

async function main() {
  const destinatarios = resultado.filter((r) => r.revisarManual === false && r.telefono);

  console.log(`Total en resultado-fusion.json: ${resultado.length}`);
  console.log(`Con teléfono resuelto (revisarManual=false): ${destinatarios.length}`);
  console.log(`Modo: ${ENVIAR ? 'ENVÍO REAL' : 'PRUEBA (dry-run, no se manda nada)'}`);
  if (LIMITE !== Infinity) console.log(`Límite de esta corrida: ${LIMITE}`);
  console.log(`Plantilla: "${TEMPLATE_NAME}" (${TEMPLATE_LANG})\n`);

  let enviados = 0, omitidos = 0, fallidos = 0, procesados = 0;

  for (const persona of destinatarios) {
    if (procesados >= LIMITE) break;

    const waId = normalizarTelefono(persona.telefono);
    if (!waId) {
      console.log(`  ⏭️  Omitido (teléfono inválido): ${persona.nombreContacto} -> "${persona.telefono}"`);
      omitidos++;
      continue;
    }

    procesados++;

    if (!ENVIAR) {
      console.log(`  📋 [PRUEBA] Se mandaría a ${persona.nombreContacto} (${waId}), variable {{1}} = "${persona.nombreContacto}"`);
      continue;
    }

    try {
      const status = await enviarPlantilla(waId, persona.nombreContacto);
      console.log(`  ✅ Enviado a ${persona.nombreContacto} (${waId}). Status: ${status}`);
      enviados++;
    } catch (error) {
      const detail = error?.response?.data ?? error?.message;
      console.error(`  ❌ Falló para ${persona.nombreContacto} (${waId}): ${JSON.stringify(detail)}`);
      fallidos++;
    }
  }

  console.log(`\nResumen: procesados ${procesados}, enviados ${enviados}, fallidos ${fallidos}, omitidos por teléfono inválido ${omitidos}.`);
  if (!ENVIAR) {
    console.log('\n(No se envió nada de verdad. Corre con --enviar cuando la plantilla esté aprobada y quieras mandar de verdad. Usa --limite N para probar con pocos primero.)');
  }
}

main().catch((e) => {
  console.error('Error inesperado:', e);
  process.exit(1);
});
