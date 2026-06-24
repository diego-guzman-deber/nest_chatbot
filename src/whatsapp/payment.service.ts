import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { PlanesService } from '../planes/planes.service';

// Plan de prueba de 1 Bs: vive solo aquí y en el prompt, no en MongoDB
const PLAN_PRUEBA = { itemId: 'TEST01', monto: 1 };

@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly planesService: PlanesService,
  ) {}

  /**
   * Obtiene el itemId y monto para un plan dado.
   * Consulta MongoDB primero; si no encuentra el plan, verifica si es el plan de prueba.
   */
  async resolverPlan(planNombre: string): Promise<{ itemId: string; monto: number } | null> {
    const normalized = planNombre.toLowerCase().trim();

    // Verificar si es el plan de prueba (no está en MongoDB)
    if (normalized.includes('prueba') || normalized === 'test01') {
      this.logger.log(`Plan de prueba detectado: "${planNombre}" → itemId=${PLAN_PRUEBA.itemId}`);
      return PLAN_PRUEBA;
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
   * Genera el orderId para suscripciones en el formato: sus-{userId}-{YYYYMM}
   * El userId en este contexto es el waId del usuario de WhatsApp.
   */
  generarOrderId(waId: string): string {
    const now = new Date();
    const yyyymm = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
    return `sus-${waId}-${yyyymm}`;
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
    const baseUrl = this.config.get<string>('QR_API_URL') ?? 'https://apipos.eldeber.com.bo/qrpayment';
    const sistema = this.config.get<string>('QR_SISTEMA') ?? 'suscripcion';

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

  /**
   * Consulta el estado del pago de una suscripción en la API de El Deber.
   */
  async consultarEstadoPago(orderId: string): Promise<boolean> {
    const apiKey  = this.config.get<string>('ELDEBER_API_KEY') ?? '';
    const baseUrl = this.config.get<string>('CLB_API_URL') ?? 'https://clb.eldeber.com.bo/api/v1';
    const url     = `${baseUrl}/CSuscripcion/${orderId}`;

    try {
      const response = await axios.get(url, {
        headers: { 'x-api-key': apiKey },
      });

      if (response.data && response.data.pagado === true) {
        this.logger.log(`Suscripción ${orderId} verificada como PAGADA.`);
        return true;
      }

      this.logger.debug(`Suscripción ${orderId} aún no ha sido pagada.`);
      return false;
    } catch (error: any) {
      this.logger.error(`Error al consultar estado de suscripción ${orderId}: ${error.message}`);
      return false;
    }
  }
}
