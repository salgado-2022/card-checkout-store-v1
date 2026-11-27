import { Controller, Get, Param } from '@nestjs/common';
import { ApiNotFoundResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { GetProduct } from '../../../application/use-cases/get-product';
import { GetProducts } from '../../../application/use-cases/get-products';
import { toHttpException } from '../error-catalog';
import { ErrorEnvelopeDto } from '../dto/error-envelope.dto';
import { ProductResponseDto } from '../dto/product.response.dto';

// Controllers only call the use case and translate its Result. No business logic lives here.
@ApiTags('products')
@Controller('products')
export class ProductsController {
  constructor(
    private readonly getProducts: GetProducts,
    private readonly getProduct: GetProduct,
  ) {}

  @Get()
  @ApiOkResponse({ type: ProductResponseDto, isArray: true })
  async list(): Promise<ProductResponseDto[]> {
    const result = await this.getProducts.execute();
    if (result.isErr()) {
      throw toHttpException(result.error);
    }
    return [...result.value];
  }

  @Get(':id')
  @ApiOkResponse({ type: ProductResponseDto })
  @ApiNotFoundResponse({ type: ErrorEnvelopeDto, description: 'PRODUCT_NOT_FOUND' })
  async detail(@Param('id') id: string): Promise<ProductResponseDto> {
    const result = await this.getProduct.execute(id);
    if (result.isErr()) {
      throw toHttpException(result.error);
    }
    return result.value;
  }
}
