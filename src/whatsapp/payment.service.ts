import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
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
   * Obtiene la imagen del QR de suscripciones como Buffer binario, llamando
   * DIRECTO a la API del BCP (mismo endpoint, certificado mTLS y credenciales
   * que usa el proyecto apipos en qrcode.php). Se bypassa apipos.eldeber.com.bo
   * porque ese endpoint hardcodea expiration="1/02:15" (~1 día) sin importar
   * lo que se le mande — acá sí controlamos la vigencia real del QR (15 min).
   */
  async obtenerQrBuffer(
    amount: number,
    orderId: string,
    razonSocial: string,
    nit: string,
    itemId: string,
  ): Promise<Buffer> {
    const sistema = this.config.getOrThrow<string>('QR_SISTEMA');
    const descripcion = `${razonSocial}|${nit}`;
    const expiration = this.config.get<string>('BCP_EXPIRATION') ?? '0/00:15';

    const bcpUrl = this.config.getOrThrow<string>('BCP_QR_API_URL');
    const authUser = this.config.getOrThrow<string>('BCP_AUTH_USER');
    const authPassword = this.config.getOrThrow<string>('BCP_AUTH_PASSWORD');
    const correlationId = `QR-${orderId}`;

    const params = {
      orderid:      orderId,
      sistema:      sistema,
      tipo:         itemId,
      descripcion:  descripcion,
      currency:     'BOB',
      amount:       String(amount),
      appUserId:    this.config.getOrThrow<string>('BCP_APP_USER_ID'),
      serviceCode:  this.config.getOrThrow<string>('BCP_SERVICE_CODE'),
      Gloss:        `QR-${orderId} ${amount} ${sistema}`,
      expiration:   expiration,
      businessCode: this.config.getOrThrow<string>('BCP_BUSINESS_CODE'),
      publicToken:  this.config.getOrThrow<string>('BCP_PUBLIC_TOKEN'),
      City:         this.config.getOrThrow<string>('BCP_CITY'),
      Teller:       this.config.getOrThrow<string>('BCP_TELLER'),
      singleUse:    'true',
      enableBank:   'ALL',
      PhoneNumber:  this.config.getOrThrow<string>('BCP_PHONE_NUMBER'),
      BranchOffice: this.config.getOrThrow<string>('BCP_BRANCH_OFFICE'),
    };

    this.logger.log(
      `Solicitando QR directo al BCP: orden=${orderId}, monto=${amount} Bs, sistema=${sistema}, tipo=${itemId}, expiration=${expiration}`,
    );

    try {
      const pem = this.obtenerCertificadoBcp();
      const httpsAgent = new https.Agent({ cert: pem, key: pem });
      const authHeader = 'Basic ' + Buffer.from(`${authUser}:${authPassword}`).toString('base64');

      const response = await axios.post(bcpUrl, params, {
        httpsAgent,
        headers: {
          'Correlation-Id': correlationId,
          Authorization: authHeader,
          'Content-Type': 'application/json',
        },
      });

      const data = response.data?.data;
      if (!data?.qrImage) {
        this.logger.error(`Respuesta del BCP sin qrImage para la orden ${orderId}: ${JSON.stringify(response.data)}`);
        throw new Error('La respuesta del BCP no incluyó la imagen del QR.');
      }

      this.logger.log(`QR del BCP generado para la orden ${orderId}, expirationDate=${data.expirationDate}`);
      return Buffer.from(data.qrImage, 'base64');
    } catch (error: any) {
      this.logger.error(`Error al obtener QR directo del BCP: ${error.message}`, error.stack);
      throw error;
    }
  }

  /**
   * Obtiene el certificado mTLS del BCP (cert + key combinados en un solo PEM).
   * En producción (Dokploy) NO existe el archivo /certs en el contenedor —solo
   * se inyectan variables de entorno—, así que ahí se usa BCP_CERT_BASE64 (el
   * PEM codificado en base64). En local se usa BCP_CERT_PATH apuntando al
   * archivo en certs/.
   */
  private obtenerCertificadoBcp(): Buffer {
    const certBase64 = this.config.get<string>('BCP_CERT_BASE64');
    if (certBase64) {
      return Buffer.from(certBase64, 'base64');
    }

    const certPath = path.resolve(this.config.getOrThrow<string>('BCP_CERT_PATH'));
    return fs.readFileSync(certPath);
  }
}
