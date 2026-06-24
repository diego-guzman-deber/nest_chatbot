import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosError } from 'axios';
import { PlanesService } from '../planes/planes.service';

// ── Constantes de la API real de El Deber (obtenidas del proyecto paywall) ───
const ELDEBER_ADMIN_API = 'https://admin.eldeber.bo/api/v1';
const ELDEBER_ADMIN_KEY = 'd24dbceeb3a8b998baee4f821b7f14d1';

// Plan de prueba de 1 Bs: vive solo aquí y en el prompt, no en MongoDB
const PLAN_PRUEBA = { itemId: 'ChatbotSus', monto: 1 };

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
    if (normalized.includes('prueba') || normalized === 'chatbotsus') {
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
   * Genera el orderId para suscripciones originadas desde el chatbot de WhatsApp.
   * Formato: wa-{waId}-{YYYYMM}
   *   - Prefijo "wa-" identifica en la DB de El Deber que el pago vino del chatbot de WhatsApp.
   *   - {waId} = número de WhatsApp del usuario (ej: 59164442738).
   *   - {YYYYMM} = año y mes de la suscripción (ej: 202406).
   * Ejemplo resultado: wa-59164442738-202406
   */
  generarOrderId(waId: string): string {
    const now = new Date();
    const yyyymm = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
    return `wa-${waId}-${yyyymm}`;
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
   * Busca un contacto en EspoCRM por email. Si no existe, lo crea.
   * Retorna el contactId (string).
   */
  async obtenerOCrearContacto(email: string, razonSocial: string): Promise<string> {
    const baseUrl = this.config.get<string>('ELDEBER_ADMIN_API') ?? ELDEBER_ADMIN_API;
    const apiKey  = this.config.get<string>('ELDEBER_ADMIN_KEY') ?? ELDEBER_ADMIN_KEY;
    const url = `${baseUrl}/Contact`;

    const cleanEmail = email.toLowerCase().trim();

    try {
      this.logger.log(`Buscando contacto en EspoCRM para email: ${cleanEmail}`);
      const searchRes = await axios.get(url, {
        headers: { 'x-api-key': apiKey },
        params: {
          maxSize: 1,
          offset: 0,
          'whereGroup[0][type]': 'equals',
          'whereGroup[0][attribute]': 'emailAddress',
          'whereGroup[0][value]': cleanEmail,
          attributeSelect: 'id,name,emailAddress',
        },
      });

      if (searchRes.data && searchRes.data.total > 0 && searchRes.data.list && searchRes.data.list.length > 0) {
        const contactId = searchRes.data.list[0].id;
        this.logger.log(`Contacto encontrado en EspoCRM: ${cleanEmail} → ID: ${contactId}`);
        return contactId;
      }

      this.logger.log(`Contacto no encontrado. Creando contacto en EspoCRM para: ${cleanEmail}`);
      const createRes = await axios.post(
        url,
        {
          name: razonSocial || 'Usuario Chatbot',
          emailAddress: cleanEmail,
          emailAddressData: [
            {
              emailAddress: cleanEmail,
              primary: true,
              optOut: false,
              invalid: false,
              lower: cleanEmail,
            },
          ],
          cSubscribed: false,
        },
        {
          headers: {
            'x-api-key': apiKey,
            'Content-Type': 'application/json',
          },
        },
      );

      const newContactId = createRes.data.id;
      this.logger.log(`Contacto creado exitosamente en EspoCRM: ${cleanEmail} → ID: ${newContactId}`);
      return newContactId;
    } catch (error: any) {
      this.logger.error(`Error en obtenerOCrearContacto para ${cleanEmail}: ${error.message}`, error.stack);
      throw error;
    }
  }

  /**
   * Consulta el estado del pago de una suscripción en la API de El Deber.
   * Si se provee email, busca por emailAddress (igual que cybersource-callback.php del proyecto paywall)
   * de lo contrario busca por cIdpaywall (orderId).
   * Devuelve true si cSubscribed es true.
   */
  async consultarEstadoPago(orderId: string, email?: string): Promise<boolean> {
    const baseUrl = this.config.get<string>('ELDEBER_ADMIN_API') ?? ELDEBER_ADMIN_API;
    const apiKey  = this.config.get<string>('ELDEBER_ADMIN_KEY') ?? ELDEBER_ADMIN_KEY;
    const url = `${baseUrl}/Contact`;

    try {
      const params: any = {
        maxSize: 1,
        offset: 0,
        attributeSelect: 'id,name,cSubscribed,cIdpaywall,emailAddress',
      };

      if (email) {
        params['whereGroup[0][type]'] = 'equals';
        params['whereGroup[0][attribute]'] = 'emailAddress';
        params['whereGroup[0][value]'] = email.toLowerCase().trim();
      } else {
        params['whereGroup[0][type]'] = 'equals';
        params['whereGroup[0][attribute]'] = 'cIdpaywall';
        params['whereGroup[0][value]'] = orderId;
      }

      const response = await axios.get(url, {
        headers: { 'x-api-key': apiKey },
        params,
      });

      const data = response.data;

      // Si encontró al menos un contacto con ese orderId/email y tiene suscripción activa
      if (data && data.total > 0 && data.list && data.list.length > 0) {
        const contacto = data.list[0];
        if (contacto.cSubscribed === true || contacto.cSubscribed === 1 || contacto.cSubscribed === '1') {
          this.logger.log(`Suscripción ${orderId} (email: ${email || 'N/A'}) verificada como PAGADA. Contacto: ${contacto.name}`);
          return true;
        }
      }

      this.logger.debug(`Suscripción ${orderId} (email: ${email || 'N/A'}) aún no está activa en El Deber.`);
      return false;
    } catch (error: unknown) {
      const axiosError = error as AxiosError;
      const status = axiosError?.response?.status;
      if (status === 404) {
        this.logger.debug(`Suscripción ${orderId} (email: ${email || 'N/A'}) aún no registrada en El Deber (404).`);
      } else {
        this.logger.warn(`Error al consultar estado de suscripción ${orderId}: ${axiosError.message} (HTTP ${status ?? 'desconocido'})`);
      }
      return false;
    }
  }
}
