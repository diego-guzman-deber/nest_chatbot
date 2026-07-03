import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { Model } from 'mongoose';
import * as fs from 'fs';
import * as path from 'path';
import { LegacyVencido, LegacyVencidoDocument } from './schemas/legacy-vencido.schema';
import {
  LegacyVencidosCampanaEstado,
  LegacyVencidosCampanaEstadoDocument,
} from './schemas/legacy-vencidos-campana-estado.schema';
import { WhatsappSenderService } from '../whatsapp/whatsapp-sender.service';

const CLAVE_CANDADO = 'legacy_vencidos';

interface RegistroSemilla {
  csuscripcionId: string;
  contactId: string;
  nombre: string;
  razonSocial: string;
  plan: string;
  telefono: string | null;
  email: string;
  fechaFin: string | null;
  fuenteTelefono: string | null;
}

/**
 * LegacyVencidosCampanaService
 *
 * Envía por WhatsApp un aviso a los suscriptores de antes del chatbot que
 * pagaron pero nunca fueron desactivados (ver scripts/fusionar-vencidos-telefonos.js),
 * SOLO a los registros con revisarManual=false (teléfono resuelto con
 * confianza) y que todavía no recibieron el mensaje.
 *
 * DESACTIVADO POR DEFECTO. No envía nada hasta que en el .env del servidor
 * se ponga LEGACY_VENCIDOS_CAMPANA_HABILITADA=true. El cron corre cada 5
 * minutos, así que basta con cambiar esa variable y reiniciar el proceso (o
 * hacer redeploy) para que arranque el envío en los siguientes 5 minutos,
 * sin tocar código.
 *
 * Antes de habilitar hace falta:
 *   1. Haber corrido `node scripts/fusionar-vencidos-telefonos.js <csv> --guardar`
 *      en el servidor (donde Mongo es alcanzable) para llenar la colección
 *      legacy_vencidos_whatsapp.
 *   2. Tener la plantilla de WhatsApp ya redactada y APROBADA por Meta, y sus
 *      variables configuradas en WHATSAPP_TEMPLATE_LEGACY_VENCIDOS_NAME /
 *      _LANG en el .env (si no se configuran, usa un nombre por defecto que
 *      probablemente no existe todavía — el envío fallará controladamente
 *      hasta que se cree la plantilla real).
 */
@Injectable()
export class LegacyVencidosCampanaService {
  private readonly logger = new Logger(LegacyVencidosCampanaService.name);

  constructor(
    @InjectModel(LegacyVencido.name) private readonly legacyVencidoModel: Model<LegacyVencidoDocument>,
    @InjectModel(LegacyVencidosCampanaEstado.name)
    private readonly campanaEstadoModel: Model<LegacyVencidosCampanaEstadoDocument>,
    private readonly whatsappSenderService: WhatsappSenderService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Siembra en Mongo los registros ya resueltos (revisarManual=false) que
   * vienen embebidos en el build (src/legacy-vencidos/data/seed-legacy-vencidos.json).
   * Existe porque Mongo solo es alcanzable desde el propio servidor — no
   * desde la máquina donde se corre el script de fusión — así que la carga
   * a la base de datos la hace la app ya desplegada, vía el endpoint
   * POST /legacy-vencidos/sembrar (ver LegacyVencidosController).
   * Es idempotente: se puede llamar varias veces sin duplicar (upsert por csuscripcionId).
   */
  async sembrarDesdeArchivoEmbebido(): Promise<{ insertados: number; actualizados: number; total: number }> {
    const rutaSemilla = path.join(__dirname, 'data', 'seed-legacy-vencidos.json');
    const contenido = fs.readFileSync(rutaSemilla, 'utf8');
    const registros: RegistroSemilla[] = JSON.parse(contenido);

    let insertados = 0;
    let actualizados = 0;

    for (const r of registros) {
      const res = await this.legacyVencidoModel.updateOne(
        { csuscripcionId: r.csuscripcionId },
        {
          $set: {
            contactId: r.contactId,
            nombre: r.nombre,
            razonSocial: r.razonSocial,
            plan: r.plan,
            telefono: r.telefono,
            email: r.email,
            fechaFin: r.fechaFin,
            fuenteTelefono: r.fuenteTelefono,
            revisarManual: false,
            actualizadoEn: new Date(),
          },
          $setOnInsert: {
            recordatorioEnviado: false,
            recordatorioEnviadoEn: null,
          },
        },
        { upsert: true },
      );
      if (res.upsertedCount > 0) insertados++;
      else actualizados++;
    }

    this.logger.log(`Siembra legacy vencidos: ${insertados} insertados, ${actualizados} actualizados de ${registros.length} totales.`);
    return { insertados, actualizados, total: registros.length };
  }

  /**
   * Corre cada 5 minutos, pero la campaña en sí solo se ejecuta UNA VEZ en
   * toda la vida del despliegue: la primera corrida que encuentra la bandera
   * en true reclama el candado (atómico, a prueba de que el cron dispare dos
   * veces casi al mismo tiempo) y a partir de ahí ninguna corrida futura
   * vuelve a entrar, sin importar cuánto tiempo se quede la bandera en true.
   */
  @Cron('*/5 * * * *')
  async revisarYEnviarCampana(): Promise<void> {
    const habilitada = this.config.get<string>('LEGACY_VENCIDOS_CAMPANA_HABILITADA') === 'true';
    if (!habilitada) {
      return;
    }

    const reclamado = await this.reclamarCandadoDeUnaSolaCorrida();
    if (!reclamado) {
      // Ya corrió antes (en esta corrida o en una anterior). No se vuelve a intentar.
      return;
    }

    this.logger.log('Candado de campaña legacy vencidos reclamado. Esta es la ÚNICA corrida que va a enviar mensajes.');

    let pendientes: LegacyVencidoDocument[];
    try {
      pendientes = await this.legacyVencidoModel
        .find({ revisarManual: false, recordatorioEnviado: { $ne: true }, telefono: { $ne: null } })
        .exec();
    } catch (error: any) {
      this.logger.error(`Error consultando legacy_vencidos_whatsapp: ${error.message}`, error.stack);
      return;
    }

    this.logger.log(`${pendientes.length} mensaje(s) por enviar.`);

    // Plantilla aprobada: "¡Hola, {{1}}! Qué gusto saludarte de parte de EL DEBER..."
    // Una sola variable: {{1}} = nombre del suscriptor.
    const templateName = this.config.get<string>('WHATSAPP_TEMPLATE_LEGACY_VENCIDOS_NAME') ?? 'vencimiento_suscripcion_caso_unico';
    const templateLang = this.config.get<string>('WHATSAPP_TEMPLATE_LEGACY_VENCIDOS_LANG') ?? 'es';

    let enviados = 0;
    let fallidos = 0;
    let omitidos = 0;

    for (const registro of pendientes) {
      const waId = this.normalizarTelefonoBolivia(registro.telefono);
      if (!waId) {
        this.logger.warn(
          `Teléfono inválido/no boliviano para "${registro.nombre || registro.razonSocial}" (${registro.csuscripcionId}): "${registro.telefono}". Se omite (no cuenta como enviado ni como fallido).`,
        );
        omitidos++;
        continue;
      }

      const nombre = (registro.nombre || registro.razonSocial || '').trim();

      try {
        const enviado = await this.whatsappSenderService.enviarPlantilla(waId, templateName, templateLang, [nombre]);
        if (!enviado) {
          this.logger.warn(`No se pudo enviar a ${waId} (${registro.csuscripcionId}). No se reintentará solo — la campaña ya no vuelve a correr sola.`);
          fallidos++;
          continue;
        }
        await this.legacyVencidoModel.updateOne(
          { _id: registro._id },
          { $set: { recordatorioEnviado: true, recordatorioEnviadoEn: new Date() } },
        );
        this.logger.log(`Enviado a ${waId} (${registro.csuscripcionId}).`);
        enviados++;
      } catch (error: any) {
        this.logger.error(`Error enviando/registrando para ${waId} (${registro.csuscripcionId}): ${error.message}`);
        fallidos++;
      }
    }

    this.logger.log(
      `Campaña legacy vencidos terminada (corrida única). Enviados: ${enviados}, fallidos: ${fallidos}, omitidos por teléfono inválido: ${omitidos}.`,
    );
  }

  /**
   * Intenta reclamar el candado de una sola corrida de forma atómica.
   * Devuelve true solo para la corrida que efectivamente lo reclama (la
   * primera). Cualquier corrida posterior recibe false y no hace nada más.
   */
  private async reclamarCandadoDeUnaSolaCorrida(): Promise<boolean> {
    // Asegura que el documento exista (no reclama nada si ya existe).
    await this.campanaEstadoModel.updateOne(
      { clave: CLAVE_CANDADO },
      { $setOnInsert: { clave: CLAVE_CANDADO, ejecutadaEn: null } },
      { upsert: true },
    );

    // Reclamo atómico: solo tiene éxito si ejecutadaEn seguía en null.
    const resultado = await this.campanaEstadoModel.findOneAndUpdate(
      { clave: CLAVE_CANDADO, ejecutadaEn: null },
      { $set: { ejecutadaEn: new Date() } },
    );

    return resultado !== null;
  }

  /**
   * El directorio de circulación guarda números locales de 8 dígitos (sin
   * código de país). WhatsApp necesita el waId con código de país (591...).
   * Devuelve null si el número no tiene pinta de celular boliviano válido,
   * para no intentar mandarle un mensaje a un número inventado/extranjero.
   */
  private normalizarTelefonoBolivia(telefonoCrudo: string | null): string | null {
    if (!telefonoCrudo) return null;
    const soloDigitos = telefonoCrudo.replace(/\D/g, '');

    if (soloDigitos.length === 8 && /^[67]/.test(soloDigitos)) {
      return `591${soloDigitos}`;
    }
    if (soloDigitos.length === 11 && soloDigitos.startsWith('591') && /^591[67]/.test(soloDigitos)) {
      return soloDigitos;
    }
    return null;
  }
}
