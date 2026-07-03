/**
 * Cruza las suscripciones vencidas (data/vencidos.json — 45 registros, sacados
 * en vivo de la API de EspoCRM: CSuscripcion + Contact) contra el export CSV del
 * directorio grande de suscriptores ("suscriptores al 3 jul 2026 (todos).xlsx"),
 * para encontrar el número de teléfono de cada uno.
 *
 * Prioridad de cruce (de más a menos confiable):
 *   1. NIT / CIF exacto (ya resuelto a mano para los 2 casos que lo tenían)
 *   2. Email exacto (normalizado, minúsculas)
 *   3. Nombre exacto normalizado (sin tildes, mayúsculas, espacios extra) —
 *      SOLO si hay una única coincidencia en todo el directorio. Si hay 0 o
 *      más de 1 coincidencia, se marca "revisar_manual" y NO se asigna
 *      teléfono, para no mandarle el mensaje de otra persona a alguien.
 *
 * Uso:
 *   node fusionar-vencidos-telefonos.js <ruta-al-csv-del-directorio> [--guardar]
 *
 * El CSV debe tener como mínimo las columnas (en cualquier orden, con esos
 * encabezados, separador , o ;): NOMBRES, TELEFONOS, CIF, EMAILS
 *
 * Sin --guardar: solo imprime el resultado y lo deja en data/resultado-fusion.json
 * Con --guardar: además inserta/actualiza en MongoDB, colección `legacy_vencidos_whatsapp`
 *   (requiere MONGODB_URI en .env y que el script corra donde Mongo sea alcanzable)
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const vencidos = require('./data/vencidos.json');

function normalizar(txt) {
  return (txt || '')
    .toString()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // quita tildes
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizarEmail(email) {
  return (email || '').toString().trim().toLowerCase();
}

function normalizarNit(nit) {
  return (nit || '').toString().replace(/\D/g, '');
}

function parseCSV(contenido) {
  const primeraLinea = contenido.split(/\r?\n/, 1)[0];
  const delim = primeraLinea.includes(';') ? ';' : ',';

  const filas = [];
  let fila = [];
  let campo = '';
  let dentroComillas = false;

  for (let i = 0; i < contenido.length; i++) {
    const c = contenido[i];
    if (dentroComillas) {
      if (c === '"') {
        if (contenido[i + 1] === '"') { campo += '"'; i++; }
        else dentroComillas = false;
      } else campo += c;
    } else {
      if (c === '"') dentroComillas = true;
      else if (c === delim) { fila.push(campo); campo = ''; }
      else if (c === '\n' || c === '\r') {
        if (campo !== '' || fila.length > 0) { fila.push(campo); filas.push(fila); }
        fila = []; campo = '';
        if (c === '\r' && contenido[i + 1] === '\n') i++;
      } else campo += c;
    }
  }
  if (campo !== '' || fila.length > 0) { fila.push(campo); filas.push(fila); }

  const encabezados = filas[0].map((h) => h.trim().toUpperCase());
  return filas.slice(1).filter((f) => f.length > 1).map((f) => {
    const obj = {};
    encabezados.forEach((h, idx) => { obj[h] = (f[idx] || '').trim(); });
    return obj;
  });
}

function main() {
  const csvPath = process.argv[2];
  const guardar = process.argv.includes('--guardar');

  if (!csvPath) {
    console.error('Uso: node fusionar-vencidos-telefonos.js <ruta-al-csv> [--guardar]');
    process.exit(1);
  }

  const contenido = fs.readFileSync(csvPath, 'utf8');
  const directorio = parseCSV(contenido);
  console.log(`Directorio cargado: ${directorio.length} filas.`);

  // Índices para cruce rápido
  const porNit = new Map();
  const porEmail = new Map();
  const porNombre = new Map(); // nombre normalizado -> [filas]

  for (const fila of directorio) {
    const nit = normalizarNit(fila.CIF);
    if (nit) {
      if (!porNit.has(nit)) porNit.set(nit, []);
      porNit.get(nit).push(fila);
    }
    const email = normalizarEmail(fila.EMAILS);
    if (email && email !== '.') {
      if (!porEmail.has(email)) porEmail.set(email, []);
      porEmail.get(email).push(fila);
    }
    const nombreNorm = normalizar(fila.NOMBRES);
    if (nombreNorm) {
      if (!porNombre.has(nombreNorm)) porNombre.set(nombreNorm, []);
      porNombre.get(nombreNorm).push(fila);
    }
  }

  const resultado = [];
  let resueltosAntes = 0, resueltosEmail = 0, resueltosNombre = 0, sinResolver = 0;

  for (const v of vencidos) {
    if (v.telefono) {
      resultado.push({ ...v, revisarManual: false });
      resueltosAntes++;
      continue;
    }

    let candidatos = [];
    let fuente = null;

    const email = normalizarEmail(v.email);
    if (email && porEmail.has(email)) {
      candidatos = porEmail.get(email);
      fuente = 'email';
    }

    // Nombres a probar: el del Contact en EspoCRM y la razón social de la
    // CSuscripcion (a veces son personas distintas escritas — mismo caso
    // real, distinto texto — por eso se intentan ambos).
    const nombresAProbar = [v.nombreContacto, v.razonSocial].filter(Boolean);

    // Nivel 1: nombre exacto normalizado (nombreContacto, luego razonSocial)
    for (const nombre of nombresAProbar) {
      if (candidatos.length > 0) break;
      const nombreNorm = normalizar(nombre);
      if (porNombre.has(nombreNorm)) {
        candidatos = porNombre.get(nombreNorm);
        fuente = 'nombre_exacto';
      }
    }

    // Nivel 2: nombre parcial — TODAS las palabras del nombre a probar están
    // contenidas en el nombre del directorio (ej. "Marcelo Vasquez" está
    // contenido en "MARCELO VASQUEZ LEMA").
    for (const nombre of nombresAProbar) {
      if (candidatos.length > 0) break;
      const tokens = normalizar(nombre).split(' ').filter(Boolean);
      if (tokens.length >= 2) {
        const parciales = directorio.filter((fila) => {
          const tokensFila = normalizar(fila.NOMBRES).split(' ').filter(Boolean);
          return tokens.every((t) => tokensFila.includes(t));
        });
        if (parciales.length > 0) {
          candidatos = parciales;
          fuente = 'nombre_parcial';
        }
      }
    }

    // Nivel 3: al menos un nombre de pila y un apellido en común entre
    // (nombreContacto + razonSocial) y el nombre del directorio. Es el nivel
    // más laxo, por eso solo se acepta si el teléfono resultante es único
    // (ver más abajo) — si hay ambigüedad, igual queda para revisión manual.
    if (candidatos.length === 0) {
      const tokensPropios = new Set(
        nombresAProbar.flatMap((n) => normalizar(n).split(' ').filter((t) => t.length >= 3)),
      );
      if (tokensPropios.size >= 2) {
        const solapados = directorio.filter((fila) => {
          const tokensFila = normalizar(fila.NOMBRES).split(' ').filter(Boolean);
          const coincidencias = tokensFila.filter((t) => tokensPropios.has(t));
          return coincidencias.length >= 2;
        });
        if (solapados.length > 0) {
          candidatos = solapados;
          fuente = 'nombre_apellido_comun';
        }
      }
    }

    // Filtrar candidatos que sí tengan un teléfono utilizable
    const conTelefono = candidatos.filter((c) => c.TELEFONOS && c.TELEFONOS !== '.' && c.TELEFONOS.trim() !== '');
    const telefonosUnicos = [...new Set(conTelefono.map((c) => c.TELEFONOS.trim()))];

    if (telefonosUnicos.length === 1) {
      resultado.push({ ...v, telefono: telefonosUnicos[0], fuenteTelefono: fuente, revisarManual: false });
      if (fuente === 'email') resueltosEmail++; else resueltosNombre++;
    } else if (telefonosUnicos.length > 1) {
      // Varias coincidencias con teléfono distinto: no se puede decidir solo.
      resultado.push({
        ...v,
        telefono: null,
        revisarManual: true,
        candidatos: conTelefono.slice(0, 5).map((c) => ({ nombre: c.NOMBRES, telefono: c.TELEFONOS, cif: c.CIF })),
      });
      sinResolver++;
    } else {
      resultado.push({ ...v, telefono: null, revisarManual: true, candidatos: [] });
      sinResolver++;
    }
  }

  console.log(`\nResumen:`);
  console.log(`  Ya resueltos antes (NIT/EspoCRM directo): ${resueltosAntes}`);
  console.log(`  Resueltos por email exacto: ${resueltosEmail}`);
  console.log(`  Resueltos por nombre exacto (única coincidencia): ${resueltosNombre}`);
  console.log(`  Sin resolver (necesitan revisión manual): ${sinResolver}`);

  const outPath = path.join(__dirname, 'data', 'resultado-fusion.json');
  fs.writeFileSync(outPath, JSON.stringify(resultado, null, 2));
  console.log(`\nGuardado en ${outPath}`);

  const pendientes = resultado.filter((r) => r.revisarManual);
  if (pendientes.length > 0) {
    console.log(`\n⚠️  ${pendientes.length} casos necesitan revisión manual:`);
    for (const p of pendientes) {
      console.log(`  - ${p.nombreContacto} (${p.email}): ${p.candidatos.length} candidato(s)`);
      p.candidatos.forEach((c) => console.log(`      · ${c.nombre} → ${c.telefono} (CIF ${c.cif})`));
    }
  }

  if (guardar) {
    const resueltos = resultado.filter((r) => !r.revisarManual);
    console.log(`\n(Se guardarán solo los ${resueltos.length} registros resueltos; los ${resultado.length - resueltos.length} con revisarManual quedan fuera de Mongo)`);
    guardarEnMongo(resueltos).catch((e) => console.error('Error guardando en Mongo:', e.message));
  } else {
    console.log('\n(No se guardó en Mongo — corre con --guardar para insertarlo en la colección legacy_vencidos_whatsapp)');
  }
}

async function guardarEnMongo(resultado) {
  const mongoose = require(path.join(__dirname, '..', 'node_modules', 'mongoose'));
  await mongoose.connect(process.env.MONGODB_URI);
  const col = mongoose.connection.collection('legacy_vencidos_whatsapp');

  let insertados = 0, actualizados = 0;
  for (const r of resultado) {
    const doc = {
      csuscripcionId: r.csuscripcionId,
      contactId: r.contactId,
      nombre: r.nombreContacto,
      razonSocial: r.razonSocial,
      plan: r.paquete,
      telefono: r.telefono,
      email: r.email,
      fechaFin: r.fechaFin,
      fuenteTelefono: r.fuenteTelefono || null,
      revisarManual: !!r.revisarManual,
      recordatorioEnviado: false,
      recordatorioEnviadoEn: null,
      actualizadoEn: new Date(),
    };
    const res = await col.updateOne(
      { csuscripcionId: r.csuscripcionId },
      { $set: doc },
      { upsert: true },
    );
    if (res.upsertedCount > 0) insertados++; else actualizados++;
  }

  console.log(`\nMongo: ${insertados} insertados, ${actualizados} actualizados en legacy_vencidos_whatsapp.`);
  await mongoose.disconnect();
}

main();
