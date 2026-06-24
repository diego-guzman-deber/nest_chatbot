import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type PlanDocument = Plan & Document;

@Schema({ collection: 'planes', timestamps: true })
export class Plan {
  @Prop({ required: true })
  nombre: string; // Nombre visible para el usuario: "ePaper + Newsletter Mensual"

  @Prop({ required: true, unique: true })
  itemId: string; // Código interno de la API de El Deber: "epaper01"

  @Prop({ required: true })
  monto: number; // Precio en Bolivianos

  @Prop({ required: true, enum: ['mensual', 'trimestral', 'semestral', 'anual', 'unico'] })
  frecuencia: string;

  @Prop({ required: true, enum: ['newsletter', 'epaper', 'impreso', 'combo'] })
  categoria: string;

  @Prop({ required: true })
  descripcion: string; // Descripción corta de lo que incluye

  @Prop({ default: true })
  activo: boolean;
}

export const PlanSchema = SchemaFactory.createForClass(Plan);
