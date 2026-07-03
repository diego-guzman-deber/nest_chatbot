import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { SuscripcionLog, SuscripcionLogDocument } from './schemas/suscripcion-log.schema';

/** Datos necesarios para registrar un pago exitoso */
export interface RegistrarPagoDto {
  email: string;
  telefono: string;
  razonSocial: string;
  nit: string;
  plan: string;
  itemId: string;
  monto: number;
  orderId: string;
  contactIdEspocrm: string;
  /** Frecuencia del plan: 'mensual' | 'trimestral' | 'semestral' | 'anual' | 'unico' */
  frecuencia?: string;
  /**
   * Inicio de la vigencia. Por defecto es la fecha del pago, pero en una
   * renovación anticipada debe ser la fechaFin de la vigencia anterior
   * (para no quitarle al usuario los días que ya tenía pagados).
   */
  fechaInicio?: Date;
  /** Fin de la vigencia. Si no se pasa, se calcula desde fechaInicio + frecuencia. */
  fechaFin?: Date | null;
}

@Injectable()
export class SuscripcionesLogService {
  private readonly logger = new Logger(SuscripcionesLogService.name);

  constructor(
    @InjectModel(SuscripcionLog.name)
    private readonly suscripcionLogModel: Model<SuscripcionLogDocument>,
  ) {}

  /**
   * Registra un pago exitoso en MongoDB.
   * Calcula la fecha de fin en función de la frecuencia del plan.
   */
  async registrarPago(dto: RegistrarPagoDto): Promise<SuscripcionLogDocument> {
    const ahora = new Date();
    const fechaInicio = dto.fechaInicio ?? ahora;
    const fechaFin = dto.fechaFin !== undefined ? dto.fechaFin : this.calcularFechaFin(fechaInicio, dto.frecuencia);

    const log = new this.suscripcionLogModel({
      email:            dto.email,
      telefono:         dto.telefono,
      razonSocial:      dto.razonSocial,
      nit:              dto.nit,
      plan:             dto.plan,
      itemId:           dto.itemId,
      monto:            dto.monto,
      orderId:          dto.orderId,
      contactIdEspocrm: dto.contactIdEspocrm,
      fechaPago:        ahora,
      fechaInicio:      fechaInicio,
      fechaFin:         fechaFin,
      activa:           true,
      fuente:           'chatbot-whatsapp',
    });

    const guardado = await log.save();

    this.logger.log(
      `[SuscripcionLog] ✅ Pago registrado: ${dto.email} | Plan: ${dto.plan} | Monto: ${dto.monto} Bs | ` +
      `FechaFin: ${fechaFin ? fechaFin.toISOString().split('T')[0] : 'N/A'} | orderId: ${dto.orderId}`,
    );

    return guardado;
  }

  /**
   * Busca todos los logs activos de un usuario por su número de teléfono.
   */
  async buscarPorTelefono(telefono: string): Promise<SuscripcionLogDocument[]> {
    return this.suscripcionLogModel.find({ telefono, activa: true }).sort({ fechaPago: -1 }).exec();
  }

  /**
   * Busca todos los logs activos de un usuario por email.
   */
  async buscarPorEmail(email: string): Promise<SuscripcionLogDocument[]> {
    return this.suscripcionLogModel.find({ email, activa: true }).sort({ fechaPago: -1 }).exec();
  }

  /**
   * Busca suscripciones activas cuya fechaFin cae dentro de los próximos `diasAntes`
   * días (ventana [ahora, ahora + diasAntes]) y que todavía no recibieron el
   * recordatorio de vencimiento. La ventana (en vez de un solo día exacto) hace
   * que, si un envío falla o el cron no corrió un día, se reintente automáticamente
   * al día siguiente mientras la suscripción siga sin vencer.
   */
  async buscarProximasAVencerSinRecordatorio(diasAntes: number): Promise<SuscripcionLogDocument[]> {
    const ahora = new Date();
    const limite = new Date(ahora);
    limite.setDate(limite.getDate() + diasAntes);

    return this.suscripcionLogModel
      .find({
        activa: true,
        recordatorioVencimientoEnviado: { $ne: true },
        fechaFin: { $gte: ahora, $lte: limite },
      })
      .exec();
  }

  /**
   * Marca una suscripción como "recordatorio de vencimiento ya enviado" para
   * no volver a notificar al usuario en corridas futuras del cron.
   */
  async marcarRecordatorioVencimientoEnviado(id: string): Promise<void> {
    await this.suscripcionLogModel.updateOne(
      { _id: id },
      { $set: { recordatorioVencimientoEnviado: true, recordatorioVencimientoEnviadoEn: new Date() } },
    ).exec();
  }

  /**
   * Busca suscripciones marcadas como activas cuya fechaFin ya pasó.
   * Son candidatas a desactivación (ver ExpiracionService) — el llamador debe
   * confirmar contra EspoCRM que no hubo una renovación antes de apagarlas.
   */
  async buscarActivasVencidas(): Promise<SuscripcionLogDocument[]> {
    return this.suscripcionLogModel
      .find({ activa: true, fechaFin: { $lt: new Date() } })
      .exec();
  }

  /**
   * Marca una suscripción del log como inactiva (venció y no se renovó, o
   * fue reemplazada por un registro más nuevo).
   */
  async marcarInactiva(id: string): Promise<void> {
    await this.suscripcionLogModel.updateOne({ _id: id }, { $set: { activa: false } }).exec();
  }

  /**
   * Calcula la fecha de fin sumando los meses/días según la frecuencia del plan.
   * Público porque también se usa para crear el registro CSuscripcion en EspoCRM.
   */
  calcularFechaFin(desde: Date, frecuencia?: string): Date | null {
    const fecha = new Date(desde);

    switch (frecuencia?.toLowerCase()) {
      case 'mensual':
        fecha.setMonth(fecha.getMonth() + 1);
        return fecha;

      case 'trimestral':
        fecha.setMonth(fecha.getMonth() + 3);
        return fecha;

      case 'semestral':
        fecha.setMonth(fecha.getMonth() + 6);
        return fecha;

      case 'anual':
        fecha.setFullYear(fecha.getFullYear() + 1);
        return fecha;

      case 'unico':
        // Acceso de un solo pago sin fecha de caducidad — 100 años
        fecha.setFullYear(fecha.getFullYear() + 100);
        return fecha;

      default:
        // Frecuencia desconocida (por ej. plan de prueba) — 1 mes por defecto
        fecha.setMonth(fecha.getMonth() + 1);
        return fecha;
    }
  }
}
