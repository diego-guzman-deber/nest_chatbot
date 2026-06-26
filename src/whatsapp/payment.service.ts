import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { PlanesService } from '../planes/planes.service';

// Plan de prueba de 1 Bs: vive solo aquí y en el prompt, no en MongoDB
const PLAN_PRUEBA = { itemId: 'ChatbotSus', monto: 1 };

/**
 * PaymentService
 *
 * Responsabilidad única: flujo de pagos QR de suscripciones.
 *   - Resolver el plan (itemId, monto, frecuencia) desde MongoDB o como plan de prueba.
 *   - Generar el orderId con formato wa-{contactId}-{YYYYMM}.
 *   - Obtener el buffer del QR de pago desde la API de El Deber.
 *
 * La gestión de contactos en EspoCRM fue extraída a EspoContactService.
 */
@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly planesService: PlanesService,
  ) {}

  /**
   * Obtiene el itemId, monto y frecuencia para un plan dado.
   * Consulta MongoDB primero; si no encuentra el plan, verifica si es el plan de prueba.
   */
  async resolverPlan(planNombre: string): Promise<{ itemId: string; monto: number; frecuencia?: string } | null> {
    const normalized = planNombre.toLowerCase().trim();

    // Verificar si es el plan de prueba (no está en MongoDB)
    if (normalized.includes('prueba') || normalized === 'chatbotsus') {
      this.logger.log(`Plan de prueba detectado: "${planNombre}" → itemId=${PLAN_PRUEBA.itemId}`);
      return { ...PLAN_PRUEBA, frecuencia: 'mensual' };
    }

    // Buscar en MongoDB
    const resultado = await this.planesService.resolverPlan(planNombre);
    if (resultado) {
      this.logger.log(`Plan resuelto desde MongoDB: "${planNombre}" → itemId=${resultado.itemId}, monto=${resultado.monto} Bs`);
      return resultado;
    }

    this.logger.warn(`Plan no encontrado ni en MongoDB ni como plan de prueba: "${planNombre}"`);
    return null;
  }

  /**
   * Genera el orderId para suscripciones originadas desde el chatbot de WhatsApp.
   * Formato: wa-{contactId}-{YYYYMM}
   *   - Prefijo "wa-" identifica en la DB de El Deber que el pago vino del chatbot.
   *   - {contactId} = ID del contacto en EspoCRM.
   *   - {YYYYMM} = año y mes de la suscripción (ej: 202406).
   * Ejemplo resultado: wa-59164442738-202406
   */
  generarOrderId(contactId: string): string {
    const now = new Date();
    const yyyymm = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
    return `wa-${contactId}-${yyyymm}`;
  }

  /**
   * Obtiene la imagen del QR de suscripciones de El Deber como Buffer binario.
   * Parámetros basados en el proyecto paywall:
   *   sistema=suscripcion, tipo={itemId}, descripcion={razonSocial}|{nit}
   */
  async obtenerQrBuffer(
    amount: number,
    orderId: string,
    razonSocial: string,
    nit: string,
    itemId: string,
  ): Promise<Buffer> {
    const baseUrl = this.config.getOrThrow<string>('QR_API_URL');
    const sistema = this.config.getOrThrow<string>('QR_SISTEMA');

    const descripcion = `${razonSocial}|${nit}`;

    this.logger.log(
      `Solicitando QR: orden=${orderId}, monto=${amount} Bs, sistema=${sistema}, tipo=${itemId}`,
    );

    try {
      const response = await axios.get(baseUrl, {
        params: {
          amount:      amount,
          orderid:     orderId,
          sistema:     sistema,
          tipo:        itemId,
          descripcion: descripcion,
        },
        responseType: 'arraybuffer',
      });

      return Buffer.from(response.data, 'binary');
    } catch (error: any) {
      this.logger.error(`Error al obtener QR de El Deber: ${error.message}`, error.stack);
      throw error;
    }
  }
}
