import { Injectable, Logger } from '@nestjs/common';
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
  ) {}

  // TEMPORAL para prueba en producción: 11:00 hora Bolivia. Volver a
  // CronExpression.EVERY_DAY_AT_9AM ('0 9 * * *') después de probar.
  @Cron('0 11 * * *', { timeZone: 'America/La_Paz' })
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

      const mensaje =
        `Hola! 👋 Tu suscripción *${suscripcion.plan}* de El Deber vence el *${fechaTexto}*.\n\n` +
        `Para que no pierdas el acceso, escríbenos por este mismo chat cuando quieras renovarla.`;

      try {
        const enviado = await this.whatsappSenderService.enviarMensaje(telefono, mensaje);
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
