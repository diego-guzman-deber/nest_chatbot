import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { OpenaiService } from './openai.service';
import { PaymentService } from './payment.service';
import { WhatsappSenderService } from './whatsapp-sender.service';
import { EspoContactService } from '../espocrm/espo-contact.service';
import { SuscripcionesLogService } from '../suscripciones/suscripciones-log.service';
import { MailService } from '../mail/mail.service';
import { PlanesService } from '../planes/planes.service';

@Injectable()
export class WhatsappService {
  private readonly logger = new Logger(WhatsappService.name);

  // Evita iniciar dos monitoreos de pago en paralelo para la misma orden
  // (p. ej. si el usuario confirma la compra dos veces por error).
  private readonly ordenesEnMonitoreo = new Set<string>();

  constructor(
    private readonly config: ConfigService,
    private readonly openaiService: OpenaiService,
    private readonly paymentService: PaymentService,
    private readonly espoContactService: EspoContactService,
    private readonly suscripcionesLogService: SuscripcionesLogService,
    private readonly whatsappSenderService: WhatsappSenderService,
    private readonly mailService: MailService,
    private readonly planesService: PlanesService,
  ) {}

  // ── Verificación del webhook (GET) ──────────────────────────────────────────

  verifyWebhook(query: Record<string, string>): string | null {
    const mode = query['hub.mode'];
    const token = query['hub.verify_token'];
    const challenge = query['hub.challenge'];

    const verifyToken = this.config.get<string>('VERIFY_TOKEN');

    if (mode === 'subscribe' && token === verifyToken) {
      this.logger.log('Webhook verificado correctamente.');
      return challenge;
    }

    this.logger.warn('Verificación de webhook fallida.');
    return null;
  }

  // ── Procesamiento de mensajes entrantes (POST) ───────────────────────────────

  async handleIncoming(body: any): Promise<void> {
    // Log completo del payload para debug
    this.logger.debug(`Payload recibido: ${JSON.stringify(body).slice(0, 500)}`);

    const entry = body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    if (!value) {
      this.logger.warn('Payload sin value, ignorando.');
      return;
    }

    // Ignorar status updates (delivered, read, sent, failed, etc.)
    if (value.statuses && value.statuses.length > 0 && !value.messages) {
      this.logger.debug(`Status update recibido: ${value.statuses[0]?.status ?? 'desconocido'}`);
      return;
    }

    // Verificar que hay mensajes
    if (!value.messages || value.messages.length === 0) {
      this.logger.warn(`Sin mensajes en el payload. Campos disponibles: ${Object.keys(value).join(', ')}`);
      return;
    }

    const message = value.messages[0];

    // Solo procesar mensajes de texto o interactivos (respuestas a botones/menús)
    if (!message || (message.type !== 'text' && message.type !== 'interactive')) {
      this.logger.log(`Tipo de mensaje ignorado: ${message?.type ?? 'desconocido'}`);
      return;
    }

    const waId: string = value.contacts?.[0]?.wa_id ?? message.from;
    const name: string = value.contacts?.[0]?.profile?.name ?? 'Usuario';
    
    let messageBody = '';
    if (message.type === 'text') {
      messageBody = message.text?.body ?? '';
    } else if (message.type === 'interactive') {
      const interactive = message.interactive;
      if (interactive?.type === 'list_reply') {
        messageBody = interactive.list_reply?.title ?? '';
      } else if (interactive?.type === 'button_reply') {
        messageBody = interactive.button_reply?.title ?? '';
      }
    }

    if (!messageBody) {
      this.logger.warn(`[${waId}] Mensaje vacío (tipo: ${message.type}), ignorando.`);
      return;
    }

    this.logger.log(`[${waId}] Mensaje de ${name} (tipo: ${message.type}): ${messageBody.slice(0, 80)}`);

    // Interceptar "Ver planes" para responder de forma estática y rápida
    let isVerPlanes = false;
    if (message.type === 'text') {
      const norm = messageBody.toLowerCase().trim();
      if (norm === 'ver planes' || norm === 'planes' || norm === 'quiero conocer los planes disponibles' || norm === 'ver planes disponibles') {
        isVerPlanes = true;
      }
    } else if (message.type === 'interactive') {
      const interactive = message.interactive;
      if (interactive?.type === 'list_reply') {
        if (interactive.list_reply?.id === 'menu_ver_planes' || messageBody.toLowerCase().trim() === 'ver planes' || messageBody.toLowerCase().trim() === 'ver planes disponibles') {
          isVerPlanes = true;
        }
      } else if (interactive?.type === 'button_reply') {
        if (interactive.button_reply?.id === 'menu_ver_planes' || messageBody.toLowerCase().trim() === 'ver planes' || messageBody.toLowerCase().trim() === 'ver planes disponibles') {
          isVerPlanes = true;
        }
      }
    }

    if (isVerPlanes) {
      this.logger.log(`[${waId}] Interceptado "Ver planes". Respondiendo con catálogo estático.`);
      try {
        const catalogo = await this.planesService.generarCatalogoEstatico();
        await this.sendMessage(waId, catalogo);
      } catch (err: any) {
        this.logger.error(`Error al responder con catálogo estático: ${err.message}`, err.stack);
        // Si hay un error al obtener de la DB, seguirá con el flujo normal de la IA como fallback
      }
      return;
    }

    // Interceptar "Hablar con asesor" para responder de forma estática y rápida
    let isHablarAsesor = false;
    if (message.type === 'text') {
      const norm = messageBody.toLowerCase().trim();
      if (norm === 'hablar con asesor' || norm === 'hablar con un asesor' || norm === 'asesor') {
        isHablarAsesor = true;
      }
    } else if (message.type === 'interactive') {
      const interactive = message.interactive;
      if (interactive?.type === 'list_reply') {
        if (interactive.list_reply?.id === 'menu_hablar_asesor' || messageBody.toLowerCase().trim() === 'hablar con asesor') {
          isHablarAsesor = true;
        }
      } else if (interactive?.type === 'button_reply') {
        if (interactive.button_reply?.id === 'menu_hablar_asesor' || messageBody.toLowerCase().trim() === 'hablar con asesor') {
          isHablarAsesor = true;
        }
      }
    }

    if (isHablarAsesor) {
      this.logger.log(`[${waId}] Interceptado "Hablar con asesor". Respondiendo con datos de Carlos Hurtado.`);
      const msg = 'Claro que sí. Puedes comunicarte directamente con nuestro asesor *Carlos Hurtado* al número de WhatsApp *+591 77305605* o ingresando directamente a este enlace: https://wa.me/59177305605';
      await this.sendMessage(waId, msg);
      return;
    }

    // Generar respuesta con OpenAI
    const reply = await this.openaiService.generateResponse(messageBody, waId, name);
    if (!reply) {
      this.logger.warn(`[${waId}] OpenAI no devolvió respuesta.`);
      return;
    }

    // Detectar si la respuesta contiene el PAYMENT_TRIGGER
    const triggerRegex = /\[PAYMENT_TRIGGER:(.*?)]/;
    const match = reply.match(triggerRegex);
    let cleanedReply = reply;

    if (match) {
      // Quitar el tag estructurado de la respuesta que se envía al usuario
      cleanedReply = reply.replace(triggerRegex, '').trim();
    }

    // Detectar si la respuesta contiene el CREATE_ACCOUNT_TRIGGER
    const createRegex = /\[CREATE_ACCOUNT_TRIGGER:(.*?)]/;
    const createMatch = cleanedReply.match(createRegex);
    if (createMatch) {
      cleanedReply = cleanedReply.replace(createRegex, '').trim();
    }

    // Detectar si la respuesta contiene el MENU_TRIGGER
    const menuRegex = /\[MENU_TRIGGER]/;
    const hasMenuTrigger = menuRegex.test(cleanedReply);
    if (hasMenuTrigger) {
      cleanedReply = cleanedReply.replace(menuRegex, '').trim();
    }

    // Limpiar el texto para WhatsApp
    const cleaned = this.processTextForWhatsapp(cleanedReply);

    // Enviar la respuesta de texto al usuario
    if (hasMenuTrigger) {
      if (cleaned) {
        await this.sendMessage(waId, cleaned);
      }
      await this.sendInteractiveListMenu(waId, 'Por favor, selecciona una de las siguientes opciones para continuar:');
    } else {
      await this.sendMessage(waId, cleaned);
    }

    // Si se detectó el trigger de pago, iniciar el proceso de cobro
    if (match) {
      const triggerData = match[1]; // plan|monto|nit|razonSocial|email
      const [plan, , nit, razonSocial, email] = triggerData.split('|');

      // Resolver el itemId, monto y frecuencia del plan contra el catálogo real
      // (MongoDB / plan de prueba). NUNCA se debe cobrar un monto que la IA haya
      // escrito libremente en el trigger: si el plan no existe en el catálogo,
      // se corta el flujo de pago en vez de generar un QR con un monto no verificado.
      const planResuelto = await this.paymentService.resolverPlan(plan);
      if (!planResuelto) {
        this.logger.error(`[${waId}] Plan no reconocido en el catálogo: "${plan}". Se aborta la generación del QR de pago.`);
        await this.sendMessage(
          waId,
          'No logré identificar ese plan en nuestro catálogo actual, así que no generé el cobro para evitar un monto incorrecto. ¿Podrías confirmarme el nombre exacto del plan? También puedes escribir "ver planes" para revisar el catálogo vigente.',
        );
        return;
      }
      const monto = planResuelto.monto;
      const itemId = planResuelto.itemId;
      const frecuencia = planResuelto.frecuencia ?? 'mensual';

      // 1. Obtener o crear el contacto en EspoCRM para obtener el contactId correcto
      let contactId = waId;
      try {
        contactId = await this.espoContactService.obtenerOCrearContacto(email, razonSocial);
      } catch (err: any) {
        this.logger.warn(
          `[${waId}] No se pudo obtener o crear el contacto en EspoCRM para ${email}: ${err.message}. Se usará waId como fallback.`,
        );
      }

      // 2. Generar el orderId de suscripción: wa-{contactId}-{YYYYMM}
      const orderId = this.paymentService.generarOrderId(contactId);

      // 3. Tomar una "foto" del contacto ANTES de generar el QR: cSubscribed
      // (para saber si ya era suscriptor) y modifiedAt (baseline para detectar
      // que el registro fue tocado DESPUÉS de esta orden, ver notas en
      // EspoContactService.consultarEstadoPagoOrden).
      let modifiedAtBaseline: string | undefined;
      try {
        const contactoPrevio = await this.espoContactService.buscarContactoPorEmail(email);
        modifiedAtBaseline = contactoPrevio?.modifiedAt;
      } catch (err: any) {
        this.logger.warn(
          `[${waId}] No se pudo obtener el estado previo del contacto para ${email}: ${err.message}. Se continuará sin baseline de modifiedAt.`,
        );
      }

      this.logger.log(
        `[${waId}] 💳 Trigger de Pago QR detectado. Order: ${orderId}, Plan: ${plan} (${itemId}), Monto: ${monto} Bs, NIT: ${nit}, Razón Social: ${razonSocial}, Email: ${email}`,
      );

      // Pasar todos los datos para que el polling guarde el log al confirmar el pago
      this.procesarYEnviarPagoQR(
        waId, monto, orderId, razonSocial, nit, itemId, email, plan, frecuencia, contactId, modifiedAtBaseline,
      ).catch((err) => {
        this.logger.error(`[${waId}] Error en el procesamiento del pago QR: ${err.message}`, err.stack);
      });
    } else if (createMatch) {
      const triggerData = createMatch[1]; // email|nombre
      const [email, nombre] = triggerData.split('|');

      this.logger.log(`[${waId}] 👤 Trigger de Crear Cuenta detectado. Email: ${email}, Nombre: ${nombre}`);

      this.crearCuentaIndependiente(waId, email, nombre).catch((err) => {
        this.logger.error(`[${waId}] Error creando cuenta independiente: ${err.message}`, err.stack);
      });
    }
  }

  // ── Procesamiento secundario del QR en Background ───────────────────────────

  private async procesarYEnviarPagoQR(
    waId: string,
    monto: number,
    orderId: string,
    razonSocial: string,
    nit: string,
    itemId: string,
    email: string,
    planNombre: string,
    frecuencia: string,
    contactIdEspocrm: string,
    modifiedAtBaseline: string | undefined,
  ): Promise<void> {
    // Evitar generar un segundo QR y un segundo monitoreo para la misma orden
    // (mismo contacto + mismo mes) si el usuario confirma la compra dos veces.
    if (this.ordenesEnMonitoreo.has(orderId)) {
      this.logger.warn(`[${waId}] Ya existe un monitoreo activo para la orden ${orderId}. Se ignora el nuevo intento de generar QR.`);
      await this.sendMessage(
        waId,
        'Ya tienes un código QR pendiente de pago para esta suscripción. Por favor usa ese mismo código; si no lo encuentras, dime y te lo reenvío.',
      );
      return;
    }

    try {
      // 1. Obtener el QR en formato binario con los parámetros correctos de suscripciones
      const qrBuffer = await this.paymentService.obtenerQrBuffer(monto, orderId, razonSocial, nit, itemId);

      // 2. Subir el QR a Meta para obtener el media_id
      const mediaId = await this.uploadMedia(qrBuffer, 'qr_pago.png', 'image/png');

      // 3. Enviar el QR por WhatsApp
      const caption = 'Aquí tienes tu código QR para realizar el pago de tu suscripción. Una vez pagado, se activará automáticamente.';
      await this.sendMediaMessage(waId, mediaId, caption);

      // 4. Iniciar el monitoreo en segundo plano (guarda el log al confirmar el pago).
      // modifiedAtBaseline permite confirmar automáticamente también renovaciones
      // de gente que ya estaba suscrita (ver EspoContactService.consultarEstadoPagoOrden).
      this.iniciarMonitoreoPago(orderId, waId, email, modifiedAtBaseline, {
        planNombre, frecuencia, monto, nit, razonSocial, itemId, contactIdEspocrm,
      });
    } catch (error: any) {
      this.logger.error(`[${waId}] Error generando o enviando el QR de pago: ${error.message}`);
      await this.sendMessage(
        waId,
        'Lo siento, ocurrió un inconveniente al generar tu código QR de pago. Por favor, vuelve a confirmar tus datos para reintentarlo.',
      );
    }
  }

  // ── Subir multimedia a la API de Meta ───────────────────────────────────────

  private async uploadMedia(buffer: Buffer, filename: string, mimeType: string): Promise<string> {
    const version = this.config.get<string>('VERSION') ?? 'v25.0';
    const phoneNumberId = this.config.get<string>('PHONE_NUMBER_ID');
    const accessToken = this.config.get<string>('ACCESS_TOKEN');

    const url = `https://graph.facebook.com/${version}/${phoneNumberId}/media`;

    const formData = new FormData();
    const blob = new Blob([new Uint8Array(buffer)], { type: mimeType });
    formData.append('file', blob, filename);
    formData.append('messaging_product', 'whatsapp');
    formData.append('type', mimeType);

    const res = await axios.post(url, formData, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!res.data || !res.data.id) {
      throw new Error('La respuesta de subida de Meta no contiene un id de media.');
    }

    return res.data.id;
  }

  // ── Enviar Mensaje de Imagen (QR) a Meta ─────────────────────────────────────

  private async sendMediaMessage(waId: string, mediaId: string, caption: string): Promise<void> {
    const version = this.config.get<string>('VERSION') ?? 'v25.0';
    const phoneNumberId = this.config.get<string>('PHONE_NUMBER_ID');
    const accessToken = this.config.get<string>('ACCESS_TOKEN');

    const url = `https://graph.facebook.com/${version}/${phoneNumberId}/messages`;

    const data = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: waId,
      type: 'image',
      image: {
        id: mediaId,
        caption: caption,
      },
    };

    await axios.post(url, data, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });

    this.logger.log(`[${waId}] QR enviado con éxito a WhatsApp.`);
  }

  // ── Monitorear Estado de Pago (Polling por email) ───────────────────────────

  private iniciarMonitoreoPago(
    orderId: string,
    waId: string,
    email: string,
    modifiedAtBaseline: string | undefined,
    datosPlan: {
      planNombre: string;
      frecuencia: string;
      monto: number;
      nit: string;
      razonSocial: string;
      itemId: string;
      contactIdEspocrm: string;
    },
  ): void {
    if (this.ordenesEnMonitoreo.has(orderId)) {
      this.logger.warn(`[${waId}] Ya hay un monitoreo activo para la orden ${orderId}, se ignora el duplicado.`);
      return;
    }
    this.ordenesEnMonitoreo.add(orderId);

    let intentos = 0;
    const maxIntentos = 30; // 30 intentos × 30 segundos = 15 minutos
    let erroresConsecutivos = 0;
    const maxErroresConsecutivos = 5; // ~2.5 min de fallas seguidas de EspoCRM

    const finalizar = () => {
      clearInterval(interval);
      this.ordenesEnMonitoreo.delete(orderId);
    };

    this.logger.log(`[${waId}] Iniciando monitoreo de pago. Order: ${orderId}, Email: ${email}`);

    const interval = setInterval(async () => {
      intentos++;

      let estado: 'confirmado' | 'pendiente' | 'sin_senal_confiable';
      try {
        // Confirma que ESTA orden fue pagada: cSubscribed=true Y (si había un
        // baseline de modifiedAt) evidencia de que el contacto fue tocado
        // después de generar el QR. Ver EspoContactService.consultarEstadoPagoOrden.
        estado = await this.espoContactService.consultarEstadoPagoOrden(orderId, email, modifiedAtBaseline);
        erroresConsecutivos = 0;
      } catch (error: any) {
        erroresConsecutivos++;
        this.logger.error(
          `[${waId}] Error consultando el pago de la orden ${orderId} (falla ${erroresConsecutivos}/${maxErroresConsecutivos}): ${error.message}`,
        );

        if (erroresConsecutivos >= maxErroresConsecutivos) {
          finalizar();
          // No le decimos al usuario que "no pagó" ni que "expiró": es un fallo
          // técnico nuestro verificando, no una certeza sobre el estado del pago.
          this.logger.error(
            `[${waId}] 🚨 CRÍTICO: no se pudo verificar el pago de la orden ${orderId} (email: ${email}, monto: ${datosPlan.monto} Bs) tras ${erroresConsecutivos} fallas consecutivas de EspoCRM. Requiere revisión manual.`,
          );
          await this.sendMessage(
            waId,
            'Tuvimos un problema técnico verificando tu pago. Si ya pagaste, no te preocupes: nuestro equipo revisará tu transacción manualmente y activará tu suscripción. Si tienes dudas, puedes escribirnos.',
          );
        }
        return;
      }

      if (estado === 'sin_senal_confiable') {
        // El contacto ya estaba suscrito antes de esta orden y EspoCRM no
        // devolvió modifiedAt para comparar: no hay forma segura de saber si
        // ESTA orden fue pagada. En vez de auto-confirmar a ciegas, se corta
        // el monitoreo y se deriva a revisión manual del equipo.
        finalizar();
        this.logger.warn(
          `[${waId}] ⚠️ ACCIÓN MANUAL REQUERIDA: no se pudo confirmar automáticamente el pago de la orden ${orderId} (email: ${email}, plan: ${datosPlan.itemId}, monto: ${datosPlan.monto} Bs, NIT: ${datosPlan.nit}, Razón Social: ${datosPlan.razonSocial}). El contacto ya estaba suscrito y EspoCRM no devolvió modifiedAt. El equipo debe verificar el pago en el panel del banco/QR y activar manualmente si corresponde.`,
        );
        await this.sendMessage(
          waId,
          'Vemos que ya cuentas con una suscripción vigente. Para este caso, un asesor verificará tu pago manualmente y te confirmaremos apenas quede procesado. Gracias por tu paciencia.',
        );
        return;
      }

      if (estado === 'confirmado') {
        finalizar();
        this.logger.log(`[${waId}] ✅ Pago confirmado por el banco para la orden ${orderId}!`);

        // ── 1. Aprovisionar usuario y contraseña (compatible con Paywall) ────────
        let contactIdReal = datosPlan.contactIdEspocrm;
        try {
          contactIdReal = await this.provisionarUsuario(
            waId,
            email,
            datosPlan.razonSocial,
            datosPlan.nit,
            datosPlan.contactIdEspocrm,
          );
        } catch (provErr: any) {
          this.logger.error(`[${waId}] Error al provisionar usuario/contacto: ${provErr.message}`, provErr.stack);
        }

        // ── 2. Guardar log de suscripción en MongoDB ──────────────────────
        try {
          await this.suscripcionesLogService.registrarPago({
            email:            email,
            telefono:         waId,
            razonSocial:      datosPlan.razonSocial,
            nit:              datosPlan.nit,
            plan:             datosPlan.planNombre,
            itemId:           datosPlan.itemId,
            monto:            datosPlan.monto,
            orderId:          orderId,
            contactIdEspocrm: contactIdReal,
            frecuencia:       datosPlan.frecuencia,
          });
        } catch (logErr: any) {
          this.logger.error(
            `[${waId}] 🚨 CRÍTICO: pago de la orden ${orderId} confirmado pero falló el registro del log de suscripción: ${logErr.message}. Requiere revisión manual para no perder el registro del cobro.`,
          );
        }

        // ── 3. Asegurar activación de la suscripción (cSubscribed = 1) ───
        try {
          await this.espoContactService.activarSuscripcion(contactIdReal);
        } catch (actErr: any) {
          this.logger.error(
            `[${waId}] 🚨 CRÍTICO: pago de la orden ${orderId} confirmado pero falló la activación en EspoCRM (contacto ${contactIdReal}): ${actErr.message}. El usuario pagó pero puede no tener acceso: requiere revisión manual.`,
          );
        }

        // ── 4. Notificar al usuario por WhatsApp ──────────────────────────
        const notificado = await this.sendMessage(
          waId,
          '¡Excelente! 🎉 Hemos verificado tu pago por QR de forma exitosa. Tu suscripción a El Deber ha sido activada correctamente. ¡Muchas gracias por confiar en nosotros! 🚀',
        );
        if (!notificado) {
          this.logger.error(
            `[${waId}] 🚨 CRÍTICO: el pago de la orden ${orderId} fue confirmado y activado, pero no se pudo notificar al usuario por WhatsApp. Requiere seguimiento manual.`,
          );
        }
        return;
      }

      if (intentos >= maxIntentos) {
        finalizar();
        this.logger.warn(`[${waId}] Monitoreo expirado sin confirmación de pago para la orden ${orderId}.`);
        await this.sendMessage(
          waId,
          'El tiempo límite (15 minutos) para realizar el pago de tu código QR ha expirado. Si aún deseas adquirir la suscripción, por favor solicítame una nueva cotización.',
        );
      }
    }, 30000);
  }

  // ── Aprovisionar usuario y credenciales post-pago ────────────────────────────

  /**
   * Verifica si el usuario ya existe en EspoCRM.
   * Si no existe, lo crea con los datos del chatbot, le genera una contraseña temporal,
   * la cifra con el formato compatible con Paywall, y envía las credenciales por mail.
   * Si existe sin contraseña, le asigna una nueva y la envía por mail.
   * Retorna el contactId final.
   */
  private async provisionarUsuario(
    waId: string,
    email: string,
    razonSocial: string,
    nit: string,
    contactIdEspocrm: string,
    activarSuscripcion: boolean = true,
  ): Promise<string> {
    const key = this.config.get<string>('PASSWORD_ENCRYPTION_KEY') ?? '1028283021';
    let contacto = await this.espoContactService.buscarContactoPorEmail(email);

    if (!contacto) {
      // Caso 1: El contacto no existe en EspoCRM
      this.logger.log(`[${waId}] Contacto no registrado en EspoCRM para ${email}. Creando contacto con contraseña...`);
      const contraseniaPlana = this.generarContraseniaTemporal(email, waId);
      const contraseniaCifrada = Buffer.from(key + contraseniaPlana).toString('base64');

      const nuevoId = await this.espoContactService.crearContactoCompleto(
        email,
        razonSocial,
        waId,
        nit,
        contraseniaCifrada,
        activarSuscripcion,
      );

      // Enviar credenciales al correo
      try {
        await this.mailService.enviarCredenciales(email, contraseniaPlana, razonSocial || 'Usuario');
      } catch (mailErr: any) {
        this.logger.error(`[${waId}] Error enviando correo de credenciales a ${email}: ${mailErr.message}`);
      }

      return nuevoId;
    } else {
      // Caso 2: El contacto existe
      this.logger.log(`[${waId}] Contacto existente encontrado en EspoCRM para ${email} (ID: ${contacto.id})`);

      // Verificar si no tiene password asignado (cPassword vacío o nulo)
      if (!contacto.cPassword) {
        this.logger.log(`[${waId}] El contacto existe pero no tiene contraseña asignada (cPassword vacío). Asignando una temporal...`);
        const contraseniaPlana = this.generarContraseniaTemporal(email, waId);
        const contraseniaCifrada = Buffer.from(key + contraseniaPlana).toString('base64');

        await this.espoContactService.actualizarPassword(contacto.id, contraseniaCifrada);

        // Enviar credenciales al correo
        try {
          await this.mailService.enviarCredenciales(email, contraseniaPlana, contacto.name || razonSocial || 'Usuario');
        } catch (mailErr: any) {
          this.logger.error(`[${waId}] Error enviando correo de credenciales a ${email}: ${mailErr.message}`);
        }
      } else {
        this.logger.log(`[${waId}] El contacto ya tiene una contraseña (cPassword) asignada en EspoCRM.`);
      }

      return contacto.id;
    }
  }

  /**
   * Genera una contraseña temporal basada en el email y el waId:
   * primeras 3 letras del email + últimos 4 dígitos del teléfono
   */
  private generarContraseniaTemporal(email: string, waId: string): string {
    const cleanEmail = email.split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '');
    const emailPrefix = cleanEmail.substring(0, 3).padEnd(3, 'x'); // Asegura 3 caracteres mínimos
    const phoneDigits = waId.trim().replace(/\D/g, ''); // Solo dígitos del teléfono
    const phoneSuffix = phoneDigits.substring(phoneDigits.length - 4).padEnd(4, '0'); // Asegura 4 dígitos mínimos
    return `${emailPrefix}${phoneSuffix}`;
  }

  // ── Limpiar texto para WhatsApp ──────────────────────────────────────────────

  private processTextForWhatsapp(text: string): string {
    // Quitar referencias 【...】 de OpenAI
    text = text.replace(/【.*?】/g, '').trim();
    // Convertir **negrita** → *negrita* (formato WhatsApp)
    text = text.replace(/\*\*(.*?)\*\*/g, '*$1*');
    return text;
  }

  // ── Envío de mensaje a la API de Meta ───────────────────────────────────────

  // Retorna true si el mensaje se envió correctamente. Los llamadores que
  // notifican eventos críticos de dinero (pago confirmado, activación) deben
  // revisar este resultado para poder alertar si el usuario nunca se enteró.
  // Delega en WhatsappSenderService (compartido con RecordatoriosService).
  private async sendMessage(waId: string, text: string): Promise<boolean> {
    return this.whatsappSenderService.enviarMensaje(waId, text);
  }

  // ── Enviar Menú Interactivo (List Reply) a Meta ──────────────────────────────
  private async sendInteractiveListMenu(waId: string, bodyText: string): Promise<void> {
    const version = this.config.get<string>('VERSION') ?? 'v25.0';
    const phoneNumberId = this.config.get<string>('PHONE_NUMBER_ID');
    const accessToken = this.config.get<string>('ACCESS_TOKEN');

    const url = `https://graph.facebook.com/${version}/${phoneNumberId}/messages`;

    const data = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: waId,
      type: 'interactive',
      interactive: {
        type: 'list',
        header: {
          type: 'text',
          text: 'Menú de opciones',
        },
        body: {
          text: bodyText,
        },
        footer: {
          text: 'El Deber',
        },
        action: {
          button: 'Ver opciones',
          sections: [
            {
              title: '¿En qué puedo ayudarte?',
              rows: [
                {
                  id: 'menu_ver_planes',
                  title: 'Ver planes disponibles',
                },
                {
                  id: 'menu_renovar_plan',
                  title: 'Renovar mi plan',
                },
                {
                  id: 'menu_preguntas_frecuentes',
                  title: 'Preguntas frecuentes',
                },
                {
                  id: 'menu_hablar_asesor',
                  title: 'Hablar con asesor',
                },
              ],
            },
          ],
        },
      },
    };

    try {
      const res = await axios.post(url, data, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      });
      this.logger.log(`[${waId}] ✅ Menú interactivo enviado. Status: ${res.status}`);
    } catch (error: any) {
      const detail = error?.response?.data ?? error?.message;
      this.logger.error(`[${waId}] ❌ Error al enviar menú interactivo: ${JSON.stringify(detail)}`);
    }
  }

  // ── Crear cuenta sin comprar un plan ─────────────────────────────────────────

  private async crearCuentaIndependiente(waId: string, email: string, nombre: string): Promise<void> {
    try {
      // Llamamos a provisionarUsuario usando '0' como NIT y sin contactId previo.
      // Pasamos false al final para NO activar la suscripción.
      await this.provisionarUsuario(waId, email, nombre, '0', '', false);
      
      await this.sendMessage(
        waId, 
        '✅ ¡Tu cuenta ha sido creada exitosamente! Por favor, revisa la bandeja de entrada de tu correo electrónico (y la carpeta de spam por si acaso) para encontrar tus credenciales de acceso.'
      );
    } catch (error: any) {
      this.logger.error(`[${waId}] Error creando cuenta independiente: ${error.message}`);
      await this.sendMessage(
        waId, 
        'Lo siento, ocurrió un problema al intentar crear tu cuenta. Por favor, intenta de nuevo más tarde o verifica si tu correo ya está registrado.'
      );
    }
  }
}
