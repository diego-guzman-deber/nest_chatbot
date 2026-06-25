import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { SuscripcionLog, SuscripcionLogSchema } from './schemas/suscripcion-log.schema';
import { SuscripcionesLogService } from './suscripciones-log.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: SuscripcionLog.name, schema: SuscripcionLogSchema },
    ]),
  ],
  providers: [SuscripcionesLogService],
  exports: [SuscripcionesLogService],
})
export class SuscripcionesModule {}
