import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  health() {
    return {
      status: 'ok',
      service: 'WhatsApp Bot',
      domain: 'chatbot.eldeber.bo',
      message: 'El servicio está funcionando correctamente 🚀',
    };
  }
}
