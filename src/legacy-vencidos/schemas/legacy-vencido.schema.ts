import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type LegacyVencidoDocument = LegacyVencido & Document;

/**
 * Suscriptores de antes del chatbot que pagaron pero nunca se desactivaron
 * (o cuyo caso hay que revisar), cruzados contra el directorio de
 * circulación para encontrar su teléfono. Ver scripts/fusionar-vencidos-telefonos.js
 * (con --guardar) para cómo se llena esta colección.
 */
@Schema({ collection: 'legacy_vencidos_whatsapp', timestamps: false })
export class LegacyVencido {
  @Prop({ required: true, unique: true, index: true })
  csuscripcionId: string;

  @Prop({ default: '' })
  contactId: string;

  @Prop({ default: '' })
  nombre: string;

  @Prop({ default: '' })
  razonSocial: string;

  @Prop({ default: '' })
  plan: string;

  /** Teléfono tal como vino del directorio de circulación (sin normalizar) */
  @Prop({ type: String, default: null })
  telefono: string | null;

  @Prop({ default: '' })
  email: string;

  @Prop({ type: String, default: null })
  fechaFin: string | null;

  @Prop({ type: String, default: null })
  fuenteTelefono: string | null;

  /** true = no se pudo cruzar con confianza, no enviar mensaje */
  @Prop({ required: true, default: true })
  revisarManual: boolean;

  /** Evita reenviar el mensaje de la campaña más de una vez por registro */
  @Prop({ required: true, default: false })
  recordatorioEnviado: boolean;

  @Prop({ type: Date, default: null })
  recordatorioEnviadoEn: Date | null;

  @Prop({ type: Date, default: () => new Date() })
  actualizadoEn: Date;
}

export const LegacyVencidoSchema = SchemaFactory.createForClass(LegacyVencido);
