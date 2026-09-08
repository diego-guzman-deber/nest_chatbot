import { Module } from '@nestjs/common';
import { MensajesController } from './mensajes.controller';
import { WhatsappModule } from '../whatsapp/whatsapp.module';

@Module({
  imports: [WhatsappModule],
  controllers: [MensajesController],
})
export class MensajesModule {}
