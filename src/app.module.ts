import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { ScheduleModule } from '@nestjs/schedule';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { WhatsappModule } from './whatsapp/whatsapp.module';
import { PlanesModule } from './planes/planes.module';
import { RecordatoriosModule } from './recordatorios/recordatorios.module';
import { LegacyVencidosModule } from './legacy-vencidos/legacy-vencidos.module';
import { MensajesModule } from './mensajes/mensajes.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),

    // ── Conexión a MongoDB usando la variable de entorno MONGODB_URI ──────
    MongooseModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => ({
        uri: config.get<string>('MONGODB_URI'),
      }),
      inject: [ConfigService],
    }),

    PlanesModule,
    WhatsappModule,
    RecordatoriosModule,
    LegacyVencidosModule,
    MensajesModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
