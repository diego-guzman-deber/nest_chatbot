import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);

  constructor(private readonly config: ConfigService) {}

  /**
   * Obtiene la imagen del QR de El Deber como Buffer binario
   */
  async obtenerQrBuffer(
    amount: number,
    orderId: string,
    razonSocial: string,
    nit: string,
  ): Promise<Buffer> {
    const descripcion = `${razonSocial}|${nit}`;
    const url = 'https://apipos.eldeber.com.bo/qrpayment';

    this.logger.log(`Solicitando QR para la orden ${orderId} por un monto de ${amount} Bs.`);

    try {
      const response = await axios.get(url, {
        params: {
          amount: amount,
          orderid: orderId,
          sistema: 'ed-clasificados',
          tipo: 'aviso',
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
   * Consulta el estado del pago del aviso en la API de El Deber
   */
  async consultarEstadoPago(adId: string): Promise<boolean> {
    const apiKey = this.config.get<string>('ELDEBER_API_KEY') || '';
    const url = `https://clb.eldeber.com.bo/api/v1/CAviso/${adId}`;

    try {
      const response = await axios.get(url, {
        headers: {
          'x-api-key': apiKey,
        },
      });

      if (response.data && response.data.pagado === true) {
        this.logger.log(`Aviso ${adId} verificado como PAGADO.`);
        return true;
      }

      this.logger.debug(`Aviso ${adId} aún no ha sido pagado.`);
      return false;
    } catch (error: any) {
      this.logger.error(`Error al consultar estado de aviso ${adId}: ${error.message}`);
      return false;
    }
  }
}
