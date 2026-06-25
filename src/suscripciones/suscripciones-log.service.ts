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
    const fechaFin = this.calcularFechaFin(ahora, dto.frecuencia);

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
      fechaInicio:      ahora,
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
   * Calcula la fecha de fin sumando los meses/días según la frecuencia del plan.
   */
  private calcularFechaFin(desde: Date, frecuencia?: string): Date | null {
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
