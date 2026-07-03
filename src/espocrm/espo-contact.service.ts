import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosError } from 'axios';



/** Campos mínimos de un contacto de EspoCRM relevantes para el chatbot */
export interface EspoContacto {
  id: string;
  name: string;
  firstName: string;
  lastName: string;
  emailAddress: string;
  cSubscribed: boolean | number | string;
  cIdpaywall?: string;
  cPassword?: string;
  /** Fecha de última modificación del registro (campo estándar de EspoCRM) */
  modifiedAt?: string;
}

/**
 * EspoContactService
 *
 * Responsabilidad única: gestionar contactos en EspoCRM (admin.eldeber.bo).
 * Encapsula todas las operaciones sobre el recurso `/Contact`:
 *   - Buscar por email
 *   - Crear si no existe
 *   - Consultar estado de suscripción (cSubscribed)
 *   - Activar suscripción (cSubscribed = 1)
 *
 * El proyecto Paywall (PHP) realiza exactamente las mismas operaciones sobre
 * esta misma API. La activación de suscripción en Paywall equivale a:
 *   PUT /Contact/{id}  { "cSubscribed": 1 }
 */
@Injectable()
export class EspoContactService {
  private readonly logger = new Logger(EspoContactService.name);

  constructor(private readonly config: ConfigService) {}

  // ── Helpers internos ────────────────────────────────────────────────────────

  private get baseUrl(): string {
    return this.config.getOrThrow<string>('ELDEBER_ADMIN_API');
  }

  private get apiKey(): string {
    return this.config.getOrThrow<string>('ELDEBER_ADMIN_KEY');
  }

  private get headers() {
    return {
      'x-api-key': this.apiKey,
      'Content-Type': 'application/json',
    };
  }

  // ── Métodos públicos ────────────────────────────────────────────────────────

  /**
   * Busca un contacto en EspoCRM por dirección de email.
   * Retorna los datos del contacto o null si no existe.
   */
  async buscarContactoPorEmail(email: string): Promise<EspoContacto | null> {
    const cleanEmail = email.toLowerCase().trim();
    const url = `${this.baseUrl}/Contact`;

    try {
      this.logger.log(`Buscando contacto en EspoCRM: ${cleanEmail}`);

      const res = await axios.get(url, {
        headers: { 'x-api-key': this.apiKey },
        params: {
          maxSize: 1,
          offset: 0,
          'whereGroup[0][type]': 'equals',
          'whereGroup[0][attribute]': 'emailAddress',
          'whereGroup[0][value]': cleanEmail,
          attributeSelect: 'id,name,firstName,lastName,emailAddress,cSubscribed,cIdpaywall,cPassword,modifiedAt',
        },
      });

      if (res.data?.total > 0 && res.data?.list?.length > 0) {
        const contacto = res.data.list[0] as EspoContacto;
        this.logger.log(`Contacto encontrado: ${cleanEmail} → ID: ${contacto.id}`);
        return contacto;
      }

      this.logger.log(`Contacto no encontrado en EspoCRM para: ${cleanEmail}`);
      return null;
    } catch (error: any) {
      this.logger.error(`Error al buscar contacto en EspoCRM (${cleanEmail}): ${error.message}`, error.stack);
      throw error;
    }
  }

  /**
   * Obtiene el ID de un contacto en EspoCRM buscando por email.
   * Si no existe, lo crea con los datos proporcionados.
   * Retorna el contactId (string).
   *
   * Migrado desde PaymentService.obtenerOCrearContacto().
   * Lógica idéntica a la que usa el proyecto Paywall en login.php y callback-*.php.
   */
  async obtenerOCrearContacto(email: string, razonSocial: string): Promise<string> {
    const cleanEmail = email.toLowerCase().trim();
    const url = `${this.baseUrl}/Contact`;

    try {
      // 1. Buscar si ya existe
      const existente = await this.buscarContactoPorEmail(cleanEmail);
      if (existente) {
        return existente.id;
      }

      // 2. Derivar firstName y lastName de la razón social
      // (mismo algoritmo que usa el proyecto Paywall en login.php)
      let firstName = 'Usuario';
      let lastName = 'Chatbot';
      const nameParts = (razonSocial || '').trim().split(/\s+/);
      if (nameParts.length > 0 && nameParts[0]) {
        firstName = nameParts[0];
        lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : 'Chatbot';
      }

      this.logger.log(
        `Creando contacto en EspoCRM: ${cleanEmail} (firstName: ${firstName}, lastName: ${lastName})`,
      );

      // 3. Crear el contacto
      // Estructura idéntica a la que usa el Paywall en callback-email.php y login.php
      const createRes = await axios.post(
        url,
        {
          name: razonSocial || 'Usuario Chatbot',
          firstName,
          lastName,
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
        { headers: this.headers },
      );

      const newContactId: string = createRes.data.id;
      this.logger.log(`Contacto creado en EspoCRM: ${cleanEmail} → ID: ${newContactId}`);
      return newContactId;
    } catch (error: any) {
      this.logger.error(
        `Error en obtenerOCrearContacto para ${cleanEmail}: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Consulta el estado de pago de una orden. Retorna:
   *   - 'confirmado': cSubscribed=true Y hay evidencia de que el contacto fue
   *     tocado DESPUÉS de generar el QR (o es un contacto nuevo, sin baseline).
   *   - 'pendiente': todavía no hay señal de pago para esta orden.
   *   - 'sin_senal_confiable': el contacto ya estaba suscrito antes de esta orden
   *     y EspoCRM no devolvió `modifiedAt` para poder comparar, así que no hay
   *     forma segura de saber si esta orden puntual fue pagada. No debe auto-
   *     confirmarse: el llamador debe derivarlo a revisión manual.
   *
   * NOTA IMPORTANTE (verificado contra el proyecto Paywall en PHP, que es el que
   * corre hoy en producción): el campo `cIdpaywall` NO es un identificador de orden
   * de pago. Es el ID del usuario en el sistema externo de autenticación "Paywall"
   * (ver login.php / api/login.php), que se asigna una única vez al crear el
   * contacto y nunca se vuelve a actualizar. Producción tampoco liga la
   * confirmación de pago a un orderId específico: solo revisa `cSubscribed` por
   * email (ver index.php, "actualiza la página para verificar el estado"). Por lo
   * tanto NO se puede usar cIdpaywall para atar el pago a esta orden.
   *
   * En su lugar usamos `modifiedAt` (campo estándar de EspoCRM, se actualiza en
   * cada escritura sobre el registro): si el llamador pasa `sinceModifiedAt`
   * (una foto de `modifiedAt` tomada ANTES de generar el QR), solo se considera
   * "pagado" cuando cSubscribed=true Y modifiedAt es posterior a esa foto. Esto
   * detecta tanto altas nuevas como renovaciones de alguien que ya estaba
   * suscrito, sin depender de que cIdpaywall cambie (no cambia).
   *
   * SUPUESTO SIN VERIFICAR: no se pudo confirmar contra una instancia real de
   * EspoCRM que el backend del banco efectivamente actualiza `modifiedAt` al
   * confirmar el pago (es el comportamiento estándar de EspoCRM, pero depende
   * de que ese proceso externo haga un PUT sobre el contacto). Probar con el
   * plan de prueba de 1 Bs sobre una cuenta ya suscrita antes de confiar del todo.
   *
   * Lanza una excepción si la consulta a EspoCRM falla por un motivo distinto a
   * "contacto no encontrado" (404), para que el llamador pueda distinguir entre
   * "todavía no pagó" y "no pudimos verificar por un error técnico".
   *
   * Migrado desde PaymentService.consultarEstadoPago().
   */
  async consultarEstadoPagoOrden(
    orderId: string,
    email: string,
    sinceModifiedAt?: string,
  ): Promise<'confirmado' | 'pendiente' | 'sin_senal_confiable'> {
    const url = `${this.baseUrl}/Contact`;

    try {
      const params: Record<string, any> = {
        maxSize: 1,
        offset: 0,
        attributeSelect: 'id,name,cSubscribed,cIdpaywall,emailAddress,modifiedAt',
        'whereGroup[0][type]': 'equals',
        'whereGroup[0][attribute]': 'emailAddress',
        'whereGroup[0][value]': email.toLowerCase().trim(),
      };

      const response = await axios.get(url, {
        headers: { 'x-api-key': this.apiKey },
        params,
      });

      const data = response.data;

      if (data?.total > 0 && data?.list?.length > 0) {
        const contacto = data.list[0] as EspoContacto;
        const suscrito =
          contacto.cSubscribed === true ||
          contacto.cSubscribed === 1 ||
          contacto.cSubscribed === '1';

        if (!suscrito) {
          this.logger.debug(`Suscripción aún no activa en EspoCRM para ${email} (orden ${orderId}).`);
          return 'pendiente';
        }

        // Sin baseline (no debería pasar en el flujo normal): confirmar por cSubscribed.
        if (!sinceModifiedAt) {
          this.logger.log(`Suscripción activa confirmada para ${email} (orden ${orderId}), sin baseline de modifiedAt.`);
          return 'confirmado';
        }

        if (!contacto.modifiedAt) {
          this.logger.warn(
            `EspoCRM no devolvió modifiedAt para ${email} (orden ${orderId}). No se puede confirmar automáticamente esta orden.`,
          );
          return 'sin_senal_confiable';
        }

        if (new Date(contacto.modifiedAt).getTime() > new Date(sinceModifiedAt).getTime()) {
          this.logger.log(
            `Pago confirmado para ${email} (orden ${orderId}): modifiedAt cambió de ${sinceModifiedAt} a ${contacto.modifiedAt}.`,
          );
          return 'confirmado';
        }

        this.logger.debug(
          `Contacto ${email} ya está suscrito pero modifiedAt no cambió desde ${sinceModifiedAt}. La orden ${orderId} aún no fue pagada.`,
        );
        return 'pendiente';
      }

      this.logger.debug(`Contacto no encontrado en EspoCRM para ${email} (orden ${orderId}).`);
      return 'pendiente';
    } catch (error: unknown) {
      const axiosError = error as AxiosError;
      const status = axiosError?.response?.status;
      if (status === 404) {
        this.logger.debug(`Contacto no registrado en EspoCRM aún (404) para ${email}.`);
        return 'pendiente';
      }
      // No swallowear: un error de red/API no significa "no pagó", significa
      // "no pudimos verificar". El llamador debe tratarlo distinto.
      this.logger.warn(
        `Error al consultar el estado de pago de la orden ${orderId} (${email}): ${axiosError.message} (HTTP ${status ?? 'desconocido'})`,
      );
      throw error;
    }
  }

  /**
   * Activa la suscripción de un contacto en EspoCRM (cSubscribed = 1).
   *
   * Este es el equivalente exacto de lo que hace el proyecto Paywall
   * al confirmar un pago exitoso: PUT /Contact/{id} { "cSubscribed": 1 }.
   *
   * Al activar cSubscribed, el usuario queda inmediatamente suscrito
   * en el ecosistema de El Deber (ePaper, newsletter, etc.).
   */
  async activarSuscripcion(contactId: string): Promise<void> {
    const url = `${this.baseUrl}/Contact/${contactId}`;

    try {
      this.logger.log(`Activando suscripción en EspoCRM para contacto ID: ${contactId}`);

      await axios.put(
        url,
        { cSubscribed: 1 },
        { headers: this.headers },
      );

      this.logger.log(`✅ Suscripción activada en EspoCRM para contacto ID: ${contactId}`);
    } catch (error: any) {
      this.logger.error(
        `Error al activar suscripción en EspoCRM para contacto ID ${contactId}: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Desactiva la suscripción de un contacto en EspoCRM (cSubscribed = 0).
   *
   * Se usa cuando venció la vigencia (CSuscripcion.fechaFin) y no hubo
   * renovación — ver ExpiracionService. Antes de llamar esto, el llamador
   * debe haber confirmado con obtenerUltimaFechaFin() que no hay una
   * vigencia futura para este contacto (si no, se cortaría el acceso a
   * alguien que sí renovó).
   */
  async desactivarSuscripcion(contactId: string): Promise<void> {
    const url = `${this.baseUrl}/Contact/${contactId}`;

    try {
      this.logger.log(`Desactivando suscripción en EspoCRM para contacto ID: ${contactId}`);

      await axios.put(
        url,
        { cSubscribed: 0 },
        { headers: this.headers },
      );

      this.logger.log(`✅ Suscripción desactivada en EspoCRM para contacto ID: ${contactId}`);
    } catch (error: any) {
      this.logger.error(
        `Error al desactivar suscripción en EspoCRM para contacto ID ${contactId}: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Obtiene la fecha de fin más lejana entre las suscripciones (CSuscripcion)
   * de un contacto, o null si no tiene ninguna con fechaFin.
   *
   * Se usa para las renovaciones: si el contacto todavía tiene vigencia
   * (fechaFin en el futuro), el nuevo período debe empezar cuando termina el
   * actual — no el día del pago — para no quitarle los días ya pagados.
   */
  async obtenerUltimaFechaFin(contactId: string): Promise<Date | null> {
    const url = `${this.baseUrl}/CSuscripcion`;

    try {
      const res = await axios.get(url, {
        headers: { 'x-api-key': this.apiKey },
        params: {
          maxSize: 1,
          orderBy: 'fechaFin',
          order: 'desc',
          'whereGroup[0][type]': 'equals',
          'whereGroup[0][attribute]': 'contactId',
          'whereGroup[0][value]': contactId,
        },
      });

      const registro = res.data?.list?.[0];
      if (!registro?.fechaFin) {
        return null;
      }

      // fechaFin viene como 'YYYY-MM-DD'; se interpreta como fin del día en Bolivia
      // para que una renovación pagada el mismo día del vencimiento aún encadene.
      const fecha = new Date(`${registro.fechaFin}T23:59:59-04:00`);
      this.logger.log(`Última fechaFin en CSuscripcion para contacto ${contactId}: ${registro.fechaFin}`);
      return isNaN(fecha.getTime()) ? null : fecha;
    } catch (error: any) {
      this.logger.warn(
        `No se pudo consultar la última fechaFin de CSuscripcion para contacto ${contactId}: ${error.message}`,
      );
      return null;
    }
  }

  /**
   * Crea un registro de suscripción en la entidad CSuscripcion de EspoCRM,
   * vinculando el contacto con el plan comprado. Esta entidad es la que usa
   * el equipo de El Deber para administrar los planes y sus vencimientos
   * (fechaFin) — es el mismo registro que crean manualmente desde el panel
   * "Suscripciones" (admin.eldeber.bo). Retorna el ID del registro creado.
   */
  async crearSuscripcion(datos: {
    contactId: string;
    razonSocial: string;
    nit: string;
    paquete: string;      // itemId del plan; debe ser una opción del enum 'paquete' de EspoCRM
    monto: number;        // en Bs
    fechaInicio: Date;
    fechaFin: Date | null;
    fechaPago: Date;
    metodoPago?: string;
    descripcion?: string;
  }): Promise<string> {
    const url = `${this.baseUrl}/CSuscripcion`;

    // EspoCRM espera fechas 'YYYY-MM-DD'; usamos la fecha local de Bolivia
    // para evitar que un pago cerca de medianoche quede con el día corrido.
    const fmt = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'America/La_Paz' });

    const payload = {
      name:         datos.razonSocial,
      contactId:    datos.contactId,
      nit:          datos.nit,
      paquete:      datos.paquete,
      precio:       datos.monto,
      monto:        datos.monto,
      fechaInicio:  fmt(datos.fechaInicio),
      fechaFin:     datos.fechaFin ? fmt(datos.fechaFin) : null,
      fechaPago:    fmt(datos.fechaPago),
      metodoPago:   datos.metodoPago ?? 'QR',
      facturado:    false,
      // Marca que la venta se originó en el chatbot de WhatsApp, para que el
      // equipo pueda distinguirlas de las creadas a mano o por otros canales.
      chatbot:      true,
      description:  datos.descripcion ?? null,
    };

    try {
      this.logger.log(
        `Creando CSuscripcion en EspoCRM: contacto=${datos.contactId}, paquete=${datos.paquete}, monto=${datos.monto} Bs, fechaFin=${payload.fechaFin}`,
      );

      const res = await axios.post(url, payload, { headers: this.headers });

      const suscripcionId: string = res.data.id;
      this.logger.log(`✅ CSuscripcion creada en EspoCRM con ID: ${suscripcionId}`);
      return suscripcionId;
    } catch (error: any) {
      const detail = error?.response?.data ?? error?.message;
      this.logger.error(
        `Error al crear CSuscripcion para contacto ${datos.contactId}: ${JSON.stringify(detail)}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Actualiza la contraseña cifrada (cPassword) de un contacto existente.
   */
  async actualizarPassword(contactId: string, contraseniaCifrada: string): Promise<void> {
    const url = `${this.baseUrl}/Contact/${contactId}`;

    try {
      this.logger.log(`Actualizando contraseña en EspoCRM para contacto ID: ${contactId}`);

      await axios.put(
        url,
        { cPassword: contraseniaCifrada },
        { headers: this.headers },
      );

      this.logger.log(`✅ Contraseña actualizada con éxito para contacto ID: ${contactId}`);
    } catch (error: any) {
      this.logger.error(
        `Error al actualizar contraseña para contacto ID ${contactId}: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Crea un contacto en EspoCRM con toda la información disponible, incluyendo
   * contraseña cifrada, teléfono y NIT.
   * Retorna el contactId (string).
   */
  async crearContactoCompleto(
    email: string,
    razonSocial: string,
    telefono: string,
    nit: string,
    contraseniaCifrada: string,
    activarSuscripcion: boolean = true,
  ): Promise<string> {
    const cleanEmail = email.toLowerCase().trim();
    const url = `${this.baseUrl}/Contact`;

    try {
      let firstName = 'Usuario';
      let lastName = 'Chatbot';
      const nameParts = (razonSocial || '').trim().split(/\s+/);
      if (nameParts.length > 0 && nameParts[0]) {
        firstName = nameParts[0];
        lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : 'Chatbot';
      }

      this.logger.log(
        `Creando contacto completo en EspoCRM: ${cleanEmail} (NIT: ${nit}, Tel: ${telefono}, Suscrito: ${activarSuscripcion})`,
      );

      const createRes = await axios.post(
        url,
        {
          name: razonSocial || 'Usuario Chatbot',
          firstName,
          lastName,
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
          cSubscribed: activarSuscripcion ? 1 : 0, // Se activa solo si es un pago exitoso
          cPassword: contraseniaCifrada,
          description: telefono,
          cIdentificationnumber: nit,
        },
        { headers: this.headers },
      );

      const newContactId: string = createRes.data.id;
      this.logger.log(`Contacto completo creado en EspoCRM: ${cleanEmail} → ID: ${newContactId}`);
      return newContactId;
    } catch (error: any) {
      this.logger.error(
        `Error en crearContactoCompleto para ${cleanEmail}: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }
}
