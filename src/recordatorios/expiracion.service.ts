import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { SuscripcionesLogService } from '../suscripciones/suscripciones-log.service';
import { EspoContactService } from '../espocrm/espo-contact.service';

/**
 * ExpiracionService
 *
 * Responsabilidad única: apagar el acceso (cSubscribed = 0 en EspoCRM) de los
 * contactos cuya suscripción venció y no fue renovada.
 *
 * Ni el chatbot ni el sitio Paywall (PHP) hacían esto antes — cSubscribed se
 * quedaba en 1 para siempre una vez activado. Corre una vez al día, después
 * de que corre RecordatoriosService, por si alguien renovó justo al ver el
 * recordatorio.
 *
 * Fuente de verdad para "¿venció de verdad?": CSuscripcion en EspoCRM (vía
 * EspoContactService.obtenerUltimaFechaFin), NO el registro local de Mongo —
 * así, si el contacto renovó por otro medio (no por el chatbot) o el
 * encadenamiento de renovación anticipada movió la fecha, no lo desactivamos
 * por error.
 */
@Injectable()
export class ExpiracionService {
  private readonly logger = new Logger(ExpiracionService.name);

  constructor(
    private readonly suscripcionesLogService: SuscripcionesLogService,
    private readonly espoContactService: EspoContactService,
  ) {}

  // Corre dos veces al día (9:00 am y 9:00 pm hora Bolivia) para no dejar a
  // nadie con acceso de más muchas horas después de vencer.
  // TEMPORAL para prueba en producción: 9:53 am hora Bolivia. Volver a
  // '0 9,21 * * *' después de probar con la suscripción de Fernando.
  @Cron('53 9 * * *', { timeZone: 'America/La_Paz' })
  async desactivarSuscripcionesVencidas(): Promise<void> {
    this.logger.log('Iniciando revisión diaria de suscripciones vencidas...');

    let candidatas;
    try {
      candidatas = await this.suscripcionesLogService.buscarActivasVencidas();
    } catch (error: any) {
      this.logger.error(`Error al consultar suscripciones vencidas: ${error.message}`, error.stack);
      return;
    }

    if (candidatas.length === 0) {
      this.logger.log('No hay suscripciones activas vencidas para revisar.');
      return;
    }

    this.logger.log(`Se encontraron ${candidatas.length} suscripción(es) vencida(s) en el log local, verificando contra EspoCRM...`);

    for (const suscripcion of candidatas) {
      const contactId = suscripcion.contactIdEspocrm;

      if (!contactId) {
        this.logger.warn(`Suscripción ${suscripcion.id} sin contactIdEspocrm, se omite y se marca inactiva localmente.`);
        await this.suscripcionesLogService.marcarInactiva(suscripcion.id).catch(() => {});
        continue;
      }

      try {
        // Fuente de verdad: la última vigencia real registrada en EspoCRM
        // (contempla renovaciones hechas por el chatbot o por otro canal).
        const ultimaFechaFin = await this.espoContactService.obtenerUltimaFechaFin(contactId);
        const ahora = new Date();

        if (ultimaFechaFin && ultimaFechaFin.getTime() > ahora.getTime()) {
          // Todavía vigente en EspoCRM en este instante — puede ser que aún no
          // haya pasado el "fin del día" de su propia fecha, o que haya una
          // renovación real más adelante. En NINGÚN caso se marca inactivo
          // acá: eso sacaría al registro para siempre de buscarActivasVencidas()
          // aunque no haya sido realmente desactivado. Se vuelve a evaluar en
          // la próxima corrida del cron.
          this.logger.log(`Contacto ${contactId} aún vigente en EspoCRM hasta ${ultimaFechaFin.toISOString().split('T')[0]}, se reevaluará en la próxima corrida.`);
          continue;
        }

        await this.espoContactService.desactivarSuscripcion(contactId);
        await this.suscripcionesLogService.marcarInactiva(suscripcion.id);
        this.logger.log(`Suscripción desactivada: contacto ${contactId} (orden ${suscripcion.orderId}, venció ${suscripcion.fechaFin?.toISOString().split('T')[0]}).`);
      } catch (error: any) {
        this.logger.error(
          `Error al procesar el vencimiento del contacto ${contactId} (orden ${suscripcion.orderId}): ${error.message}`,
        );
        // No se marca inactiva: se reintenta en la próxima corrida.
      }
    }
  }
}
