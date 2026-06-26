import { Module } from '@nestjs/common';
import { EspoContactService } from './espo-contact.service';

/**
 * EspoCrmModule
 *
 * Encapsula toda la integración con la API de administración de El Deber
 * (EspoCRM — https://admin.eldeber.bo/api/v1).
 *
 * Exporta EspoContactService para que otros módulos (WhatsappModule)
 * puedan inyectarlo sin acoplarse a los detalles de la API.
 */
@Module({
  providers: [EspoContactService],
  exports: [EspoContactService],
})
export class EspoCrmModule {}
