import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

// ── Mapeo de nombres de planes hacia los itemId usados por la API de suscripciones ──
// Basado en el proyecto paywall: sistema=suscripcion, tipo=itemId
const PLAN_ITEM_MAP: Record<string, { itemId: string; amount: number }> = {
  // Solo Newsletter
  'solo newsletter mensual':       { itemId: 'NL01',      amount: 19.90 },
  'solo newsletter trimestral':    { itemId: 'NL03',      amount: 108   },
  'solo newsletter anual':         { itemId: 'NL12',      amount: 192   },

  // Epaper + Newsletter
  'epaper newsletter mensual':     { itemId: 'epaper01',  amount: 100   },
  'epaper newsletter trimestral':  { itemId: 'EP03',      amount: 200   },
  'epaper newsletter anual':       { itemId: 'epaper12',  amount: 700   },

  // Combos digitales
  'combo epaper 3 cuentas anual':  { itemId: 'EP3C12',    amount: 1100  },
  'plan corporativo 10 cuentas':   { itemId: 'EPCORP12',  amount: 2000  },

  // Impreso + Epaper + Newsletter
  'impreso epaper mensual':        { itemId: 'Impreso1DV', amount: 240  },
  'impreso epaper trimestral':     { itemId: 'IMP03',      amount: 700  },
  'impreso epaper semestral':      { itemId: 'IMP06',      amount: 1365 },

  // Anuales impreso + epaper
  'impreso domingo viernes anual': { itemId: 'Impreso1ADV', amount: 2700 },
  'impreso lunes viernes anual':   { itemId: 'ImpLV12',     amount: 2300 },

  // Solo domingo impreso
  'impreso domingo semestral':     { itemId: 'ImpDom06',   amount: 230  },
  'impreso domingo anual':         { itemId: 'ImpDom12',   amount: 440  },

  // Plan de prueba
  'prueba':                        { itemId: 'TEST01',     amount: 1    },
};

@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);

  constructor(private readonly config: ConfigService) {}

  /**
   * Obtiene el itemId y monto para un plan dado.
   * Hace una búsqueda flexible por nombre en minúsculas.
   */
  resolverPlan(planNombre: string): { itemId: string; amount: number } | null {
    const key = planNombre.toLowerCase().trim();

    // Búsqueda exacta primero
    if (PLAN_ITEM_MAP[key]) return PLAN_ITEM_MAP[key];

    // Búsqueda parcial (contiene alguna palabra clave del plan)
    const match = Object.keys(PLAN_ITEM_MAP).find(
      (k) => key.includes(k) || k.includes(key),
    );
    return match ? PLAN_ITEM_MAP[match] : null;
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
    const sistema = this.config.get<string>('QR_SISTEMA')  ?? 'suscripcion';

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
    const apiKey  = this.config.get<string>('ELDEBER_API_KEY')  ?? '';
    const baseUrl = this.config.get<string>('CLB_API_URL')      ?? 'https://clb.eldeber.com.bo/api/v1';
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
