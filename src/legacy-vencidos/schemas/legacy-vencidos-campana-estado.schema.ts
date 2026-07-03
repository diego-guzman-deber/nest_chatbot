import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type LegacyVencidosCampanaEstadoDocument = LegacyVencidosCampanaEstado & Document;

/**
 * Candado de "una sola corrida" para la campaña de legacy vencidos. Existe
 * un único documento con clave: 'legacy_vencidos'. Mientras ejecutadaEn sea
 * null, la campaña no ha corrido nunca. En cuanto se reclama (se le pone
 * fecha), NUNCA vuelve a correr sola, aunque LEGACY_VENCIDOS_CAMPANA_HABILITADA
 * se quede en true para siempre — así se evita mandar el mensaje dos veces
 * por error (cada plantilla enviada tiene costo en Meta).
 *
 * Para forzar una segunda corrida (ej. para los que fallaron) hay que borrar
 * este documento a mano en Mongo — es una decisión deliberada, no automática.
 */
@Schema({ collection: 'legacy_vencidos_campana_estado', timestamps: false })
export class LegacyVencidosCampanaEstado {
  @Prop({ required: true, unique: true, index: true })
  clave: string;

  @Prop({ type: Date, default: null })
  ejecutadaEn: Date | null;
}

export const LegacyVencidosCampanaEstadoSchema = SchemaFactory.createForClass(LegacyVencidosCampanaEstado);
