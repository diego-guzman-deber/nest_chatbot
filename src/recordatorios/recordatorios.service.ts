import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SuscripcionesLogService } from '../suscripciones/suscripciones-log.service';
import { WhatsappSenderService } from '../whatsapp/whatsapp-sender.service';

const DIAS_ANTES_DE_VENCER = 3;

/**
 * RecordatoriosService
 *
 * Responsabilidad única: avisar por WhatsApp a los suscriptores cuya
 * suscripción está por vencer, para que puedan renovar a tiempo.
 *
 * Corre una vez al día. Por cada suscripción activa cuya fechaFin cae dentro
 * de los próximos DIAS_ANTES_DE_VENCER días y que todavía no fue notificada
 * (recordatorioVencimientoEnviado=false), envía un mensaje de WhatsApp al
 * teléfono guardado en suscripciones_log y marca el recordatorio como enviado
 * para no repetirlo.
 */
@Injectable()
export class RecordatoriosService {
  private readonly logger = new Logger(RecordatoriosService.name);

  constructor(
    private readonly suscripcionesLogService: SuscripcionesLogService,
    private readonly whatsappSenderService: WhatsappSenderService,
    private readonly config: ConfigService,
  ) {}

  // TEMPORAL para prueba en producción: 12:50 hora Bolivia. Volver a
  // CronExpression.EVERY_DAY_AT_9AM ('0 9 * * *') después de probar.
  @Cron('50 12 * * *', { timeZone: 'America/La_Paz' })
  async enviarRecordatoriosDeVencimiento(): Promise<void> {
    this.logger.log('Iniciando revisión diaria de suscripciones próximas a vencer...');

    let candidatas;
    try {
      candidatas = await this.suscripcionesLogService.buscarProximasAVencerSinRecordatorio(DIAS_ANTES_DE_VENCER);
    } catch (error: any) {
      this.logger.error(`Error al consultar suscripciones próximas a vencer: ${error.message}`, error.stack);
      return;
    }

    if (candidatas.length === 0) {
      this.logger.log('No hay suscripciones próximas a vencer sin recordatorio pendiente.');
      return;
    }

    this.logger.log(`Se encontraron ${candidatas.length} suscripción(es) para recordar.`);

    // Nombre e idioma de la plantilla aprobada en WhatsApp Manager / Meta
    // Business Suite. Fuera de la ventana de 24h, un mensaje de texto libre
    // (enviarMensaje) falla con el error 131047 — hay que usar plantilla.
    const templateName = this.config.get<string>('WHATSAPP_TEMPLATE_RECORDATORIO_NAME') ?? 'recordatorio_vencimiento_suscripcion';
    const templateLang = this.config.get<string>('WHATSAPP_TEMPLATE_RECORDATORIO_LANG') ?? 'es';

    for (const suscripcion of candidatas) {
      const telefono = suscripcion.telefono;
      const fechaFin = suscripcion.fechaFin;

      if (!telefono || !fechaFin) {
        this.logger.warn(`Suscripción ${suscripcion.id} sin teléfono o fechaFin válidos, se omite.`);
        continue;
      }

      const fechaTexto = fechaFin.toLocaleDateString('es-BO', {
        timeZone: 'America/La_Paz',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
      });

      try {
        // La plantilla debe tener dos variables en el body: {{1}} = plan, {{2}} = fecha.
        const enviado = await this.whatsappSenderService.enviarPlantilla(
          telefono,
          templateName,
          templateLang,
          [suscripcion.plan, fechaTexto],
        );
        if (!enviado) {
          this.logger.warn(`No se pudo enviar el recordatorio a ${telefono} (orden ${suscripcion.orderId}). Se reintentará en la próxima corrida.`);
          continue;
        }
        await this.suscripcionesLogService.marcarRecordatorioVencimientoEnviado(suscripcion.id);
        this.logger.log(`Recordatorio de vencimiento enviado a ${telefono} (orden ${suscripcion.orderId}, vence ${fechaTexto}).`);
      } catch (error: any) {
        this.logger.error(
          `Error enviando/registrando el recordatorio para ${telefono} (orden ${suscripcion.orderId}): ${error.message}`,
        );
        // No se marca como enviado: se reintentará en la próxima corrida mientras siga dentro de la ventana.
      }
    }
  }
}
